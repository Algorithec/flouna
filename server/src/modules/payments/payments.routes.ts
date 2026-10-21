import { settleOndcPayment } from "../ondc/ondcPay.service.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { env, isProd } from "../../config/env.js";
import {
  cashfreeConfigured,
  createCashfreeOrder,
  getCashfreeOrder,
  verifyCashfreeWebhook,
} from "./cashfree.js";
import { sendPushToUser } from "../notifications/push.service.js";
import { checkSavingsMilestone } from "../notifications/outbox.service.js";
import { sendReceiptEmail } from "../../lib/mailer.js";
import { emitOrderConfirmation } from "../backoffice/ondc.service.js";
import { refundToWallet, spendFromWallet, walletBalance } from "../users/wallet.service.js";

export const paymentsRouter = Router();

// The rewards wallet is a payment instrument, not a discount: `order.amount`
// stays the full bill and the wallet covers part of it, exactly as a gift card
// would. Keeping the bill gross is what lets the receipt, the ONDC payload and
// the savings ledger all keep reading `amount` and stay right — only the money
// the gateway has to collect changes.
type OrderLike = { amount: number; details: string };

/** Wallet credit already committed to this order, in paise. */
function walletAppliedOn(order: OrderLike): number {
  try {
    const d = JSON.parse(order.details) as { walletAppliedPaise?: number };
    return typeof d.walletAppliedPaise === "number" && d.walletAppliedPaise > 0
      ? d.walletAppliedPaise
      : 0;
  } catch {
    return 0;
  }
}

/** What still has to be collected from the buyer after the wallet. */
function payableOn(order: OrderLike): number {
  return Math.max(0, order.amount - walletAppliedOn(order));
}

// Seeded after successful payment so tracking has a live timeline.
const FOOD_EVENTS = [
  { status: "order_placed", message: "Order placed, restaurant notified" },
  { status: "preparing", message: "Restaurant is preparing your food" },
  { status: "out_for_delivery", message: "Delivery partner picked up your order" },
  { status: "arriving", message: "Your order is arriving soon" },
];

const RIDE_EVENTS = [
  { status: "driver_assigned", message: "Driver assigned and on the way" },
  { status: "arriving", message: "Your driver is arriving at pickup" },
  { status: "in_ride", message: "Ride started, enjoy the trip" },
];

/**
 * The gateway took money for an order that is cancelled: record it as owed
 * back. Status-scoped, because webhooks repeat: a refund already flagged, or
 * already paid out, must not be reopened.
 */
async function owePaymentBack(
  order: { id: string; userId: string },
  method: string,
  paidPaise: number,
  gatewayResponse: string | undefined,
) {
  const orderId = order.id;
  const opts = { paidPaise, gatewayResponse };
  const existing = await prisma.payment.findUnique({ where: { orderId } });
  const flagged = existing
    ? (
        await prisma.payment.updateMany({
          where: { orderId, status: { in: ["created", "processing", "pending", "failed"] } },
          data: {
            status: "refund_pending",
            amount: opts.paidPaise,
            method,
            gatewayResponse: opts.gatewayResponse,
          },
        })
      ).count
    : (
        await prisma.payment.create({
          data: {
            orderId,
            userId: order.userId,
            amount: opts.paidPaise,
            currency: "INR",
            status: "refund_pending",
            method,
            gatewayResponse: opts.gatewayResponse,
          },
        }),
        1
      );
  if (flagged > 0) {
    console.warn(
      `[payments] ${orderId} was paid after it was cancelled: ${opts.paidPaise} paise flagged for refund`,
    );
  }
}

async function markPaid(
  orderId: string,
  method: string,
  opts: {
    paidPaise?: number;
    gatewayResponse?: string;
    // Cash on delivery: the order is confirmed and goes into fulfilment, but
    // no money has moved yet — the payment stays pending until collected.
    collectOnDelivery?: boolean;
  } = {},
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return order;

  // The gateway took money for an order that was cancelled while its payment
  // was still in flight. The order stays cancelled, but the money has to be
  // recorded as owed back. This used to fall through to the return below: the
  // customer had paid, the payment row still said "processing", and nothing
  // told ops a refund was due.
  //
  // Only the gateway paths report an amount, so only real money reaches this.
  // Status-scoped, because webhooks repeat: a refund already flagged, or
  // already paid out, must not be reopened.
  if (order.status === "cancelled" && opts.paidPaise !== undefined) {
    await owePaymentBack(order, method, opts.paidPaise, opts.gatewayResponse);
    return order;
  }
  if (order.status !== "pending_payment") return order;

  // Amount integrity: never confirm an order for less than it costs. The
  // gateway is the source of truth for what was actually charged — but it was
  // only ever asked for the part the wallet did not cover, so that is what it
  // has to match. Comparing against the gross bill here would fail every order
  // that spent reward credit.
  const owed = payableOn(order);
  if (opts.paidPaise !== undefined && opts.paidPaise < owed) {
    await prisma.payment.updateMany({
      where: { orderId },
      data: { status: "failed", gatewayResponse: opts.gatewayResponse },
    });
    console.error(
      `[payments] amount mismatch on ${orderId}: paid ${opts.paidPaise} < owed ${owed}`,
    );
    return order;
  }

  // Scheduled rides anchor their timeline at the scheduled time — the captain
  // search starts then, not at payment. Everything else starts now.
  let timelineStart = Date.now();
  if (order.domain === "ride") {
    const details = JSON.parse(order.details) as { scheduledAt?: string };
    const scheduled = details.scheduledAt ? Date.parse(details.scheduledAt) : NaN;
    if (!Number.isNaN(scheduled) && scheduled > timelineStart) timelineStart = scheduled;
  }

  // Claim the order and write the payment + timeline in ONE transaction. The
  // status-scoped claim is what makes this exactly-once: only the first
  // concurrent PAYMENT_SUCCESS delivery flips it out of pending_payment, and a
  // duplicate sees count === 0 and aborts. Keeping the claim inside the
  // transaction means a failure anywhere (e.g. a webhook arriving for an order
  // that never went through checkout, so no payment row exists) rolls the
  // claim back too — an order can never end up "confirmed" with no payment and
  // no tracking events. The payment row is upserted for exactly that case.
  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.order.updateMany({
      where: { id: orderId, status: "pending_payment" },
      data: { status: "confirmed" },
    });
    if (claim.count === 0) return false;

    // COD money hasn't moved yet, so the payment row must not claim success.
    const paymentStatus = opts.collectOnDelivery ? "pending" : "success";

    // Cash on delivery has taken nothing yet, so it has no payment time.
    const paidAt = opts.collectOnDelivery ? null : new Date();
    await tx.payment.upsert({
      where: { orderId },
      update: { status: paymentStatus, method, gatewayResponse: opts.gatewayResponse, paidAt },
      create: {
        orderId,
        userId: order.userId,
        amount: owed,
        currency: "INR",
        status: paymentStatus,
        method,
        gatewayResponse: opts.gatewayResponse,
        paidAt,
      },
    });

    await tx.trackingEvent.createMany({
      data: (order.domain === "food" ? FOOD_EVENTS : RIDE_EVENTS).map((e, i) => ({
        orderId,
        status: e.status,
        message: e.message,
        // Future timestamps simulate live progress for the tracking screen.
        createdAt: new Date(timelineStart + i * 45_000),
      })),
    });
    return true;
  });

  if (!claimed) {
    const now = await prisma.order.findUnique({ where: { id: orderId } });
    // Cancelled between the read above and the claim. The money was still
    // taken, and without this it was owed back nowhere.
    if (now?.status === "cancelled" && opts.paidPaise !== undefined) {
      await owePaymentBack(now, method, opts.paidPaise, opts.gatewayResponse);
    }
    return now;
  }

  const updated = await prisma.order.findUnique({ where: { id: orderId } });

  // Fire-and-forget receipt email (no-op if SMTP isn't configured or the
  // user has turned off email updates — OTP/security mail is unaffected).
  void prisma.user
    .findUnique({
      where: { id: order.userId },
      select: { email: true, emailUpdates: true },
    })
    .then((u) => {
      if (u?.emailUpdates && updated) {
        return sendReceiptEmail(u.email, {
          id: updated.id,
          title: updated.title,
          domain: updated.domain,
          amount: updated.amount,
          savedPaise: updated.savedPaise,
        });
      }
    })
    .catch((err) => console.error("[payments] receipt email failed:", err));

  // Savings milestone — emails once when the lifetime total crosses ₹500/1k/5k.
  void checkSavingsMilestone(order.userId).catch(() => {});

  // Fire-and-forget confirmation push (no-op if push isn't configured).
  void sendPushToUser(order.userId, {
    title: order.domain === "food" ? "Order confirmed 🍽️" : "Ride booked 🚕",
    body:
      order.domain === "food"
        ? `${order.title} is being prepared.`
        : `${order.title}, your driver is on the way.`,
    url: `/orders/${order.id}`,
  });

  // Record the simulated ONDC confirm/status flow for the developer viewer.
  void emitOrderConfirmation(order);

  return updated;
}

// ---------- Cashfree webhook (no auth — verified by signature) ----------
// The JSON parser's verify hook preserves the exact request bytes on
// req.rawBody; the HMAC is computed over those.
paymentsRouter.post(
  "/webhook/cashfree",
  async (req, res) => {
    const signature = req.header("x-webhook-signature") ?? "";
    const timestamp = req.header("x-webhook-timestamp") ?? "";
    const rawBody =
      (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "";

    if (!verifyCashfreeWebhook(rawBody, signature, timestamp)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    try {
      const event = JSON.parse(rawBody) as {
        type?: string;
        data?: {
          order?: { order_id?: string; order_amount?: number };
          payment?: {
            payment_status?: string;
            payment_group?: string;
            payment_amount?: number;
          };
        };
      };
      const orderId = event.data?.order?.order_id;
      if (
        event.type === "PAYMENT_SUCCESS_WEBHOOK" &&
        orderId &&
        event.data?.payment?.payment_status === "SUCCESS"
      ) {
        // Cashfree reports rupees; we store paise. Use the captured payment
        // amount (falls back to the order amount) to verify integrity.
        const paidRupees =
          event.data.payment.payment_amount ?? event.data.order?.order_amount;
        const paidPaise =
          paidRupees !== undefined ? Math.round(paidRupees * 100) : undefined;
        // An ONDC order, paid for the seller's total: placed with the seller.
        if (orderId.startsWith("ondc_")) {
          if (paidPaise !== undefined) {
            const ref = (event.data.payment as { cf_payment_id?: string | number }).cf_payment_id;
            await settleOndcPayment(orderId, paidPaise, String(ref ?? orderId));
          }
          return res.json({ ok: true });
        }
        await markPaid(orderId, event.data.payment.payment_group ?? "upi", {
          paidPaise,
          gatewayResponse: rawBody,
        });
      }
      res.json({ ok: true });
    } catch {
      res.status(400).json({ error: "Malformed webhook" });
    }
  },
);

paymentsRouter.use(requireAuth);

// ---------- checkout ----------

paymentsRouter.post(
  "/checkout",
  validateBody(
    z.object({
      orderId: z.string().cuid(),
      // Cash on delivery collects money in person — it must never open an
      // online gateway. Anything else goes through Cashfree (or the simulated
      // path when no keys are configured).
      method: z.enum(["upi", "card", "cash"]).optional(),
      // Spend the rewards balance on this order. Stacks with a promo code: the
      // code already came off the bill when the order was created, so the
      // wallet only ever covers what is left after it.
      useWallet: z.boolean().optional(),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { orderId, method, useWallet } = req.body as {
        orderId: string;
        method?: "upi" | "card" | "cash";
        useWallet?: boolean;
      };
      const order = await prisma.order.findFirst({
        where: { id: orderId, userId: req.userId! },
        include: { user: true },
      });
      if (!order) throw new ApiError(404, "Order not found");
      if (order.status !== "pending_payment") {
        throw new ApiError(409, "This order is not awaiting payment");
      }

      // ---- rewards wallet ----
      //
      // Committed here, before the gateway is asked for anything, because the
      // gateway has to be asked for the reduced amount. The ledger's unique
      // (userId, orderId, reason) index means a retried checkout cannot spend
      // twice, and the applied amount is read back from the order rather than
      // re-derived, so a second attempt reuses the first attempt's debit
      // instead of adding to it. Cancelling the order returns it.
      let walletApplied = walletAppliedOn(order);

      // Once the gateway has been asked for an amount, that amount is fixed.
      // Cashfree order ids are unique, so a later checkout cannot create a new
      // session and reuses the old one, at the price it was created with.
      // Taking credit now would tell the customer a smaller number while the
      // session still charged the full one: ₹485 plus ₹300 of credit for a
      // ₹485 order. Refused, so nothing is debited and the app can say why.
      if (useWallet && walletApplied === 0) {
        const started = await prisma.payment.findUnique({
          where: { orderId },
          select: { gatewayOrderId: true },
        });
        if (started?.gatewayOrderId) {
          throw new ApiError(
            409,
            "Payment for this order has already started, so rewards can't be added to it now",
          );
        }
      }
      if (useWallet && walletApplied === 0) {
        const took = await spendFromWallet({
          userId: req.userId!,
          orderId,
          maxPaise: order.amount,
          description: `Applied to ${order.title}`,
        });
        if (took > 0) {
          // The order was read as awaiting payment before the credit was taken.
          // If it was cancelled in between, the cancellation has already run
          // and refunded nothing, so the credit goes straight back here.
          const still = await prisma.order.findUnique({
            where: { id: orderId },
            select: { status: true },
          });
          if (still?.status !== "pending_payment") {
            await refundToWallet({
              userId: req.userId!,
              orderId,
              amountPaise: took,
              description: `Returned from ${order.title}`,
            });
            throw new ApiError(409, "This order is not awaiting payment");
          }
          const details = JSON.parse(order.details) as Record<string, unknown>;
          details.walletAppliedPaise = took;
          await prisma.order.update({
            where: { id: orderId },
            data: { details: JSON.stringify(details) },
          });
          order.details = JSON.stringify(details);
          walletApplied = took;
        }
      }
      const payable = Math.max(0, order.amount - walletApplied);

      // Only a payment that has not gone through is reset for another try.
      // This used to overwrite whatever was there, so a payment confirmed
      // while a second checkout was running was turned back into an unpaid
      // one on a confirmed order, and cancelling it refunded nothing.
      const reset = await prisma.payment.updateMany({
        where: { orderId, status: { in: ["created", "processing", "failed"] } },
        data: { status: "created", amount: payable },
      });
      if (reset.count === 0) {
        const existing = await prisma.payment.findUnique({ where: { orderId } });
        if (existing) throw new ApiError(409, "This order is already paid");
        // Two first checkouts at once both find no row; the second create
        // meets the unique order id, and that row is just as unpaid.
        await prisma.payment
          .create({ data: { orderId, userId: req.userId!, amount: payable, status: "created" } })
          .catch((err: { code?: string }) => {
            if (err?.code !== "P2002") throw err;
          });
      }

      // ---- fully covered by rewards: there is nothing to collect ----
      // Sending a zero-rupee order to a gateway is rejected by every one of
      // them, so the order is confirmed straight from here.
      if (payable === 0) {
        await markPaid(orderId, "wallet");
        return res.json({ mode: "wallet", amount: 0, walletAppliedPaise: walletApplied });
      }

      // ---- cash on delivery: confirm the order, collect the money later ----
      if (method === "cash") {
        await markPaid(orderId, "cash", { collectOnDelivery: true });
        return res.json({ mode: "cash", amount: payable, walletAppliedPaise: walletApplied });
      }

      // Demo mode wins over the gateway on purpose. A pitch cannot depend on
      // a third-party checkout loading over the room's wifi, and the story is
      // about the decision engine, not about Cashfree's page.
      if (env.DEMO_PAYMENTS && !isProd) {
        const paid = await markPaid(orderId, method ?? "upi");
        return res.json({ mode: "demo", order: paid, amount: order.amount });
      }

      if (cashfreeConfigured) {
        let cf;
        try {
          cf = await createCashfreeOrder({
            orderId,
            amountPaise: payable,
            customerId: order.userId,
            customerEmail: order.user.email,
            customerPhone: order.user.phone ?? "",
            returnUrl: `${env.CASHFREE_RETURN_ORIGIN ?? env.WEB_ORIGIN}/pay/${orderId}?from=cashfree`,
          });
        } catch (err) {
          // Retried checkout: the order already exists at Cashfree — reuse its
          // still-valid payment session instead of failing the retry.
          if ((err as { cfStatus?: number }).cfStatus === 409) {
            cf = await getCashfreeOrder(orderId);
            // A session is only reusable if it charges what is owed. Whatever
            // changed the bill after payment started, handing this one out
            // would charge the customer a number they were not shown.
            if (Math.round(Number(cf.order_amount) * 100) !== payable) {
              throw new ApiError(
                409,
                "This payment no longer matches the bill. Please place the order again",
              );
            }
          } else {
            throw err;
          }
        }
        await prisma.payment.update({
          where: { orderId },
          data: { gatewayOrderId: cf.cf_order_id, status: "processing" },
        });
        return res.json({
          mode: "cashfree",
          paymentSessionId: cf.payment_session_id,
          cfEnv: env.CASHFREE_ENV,
          amount: payable,
          walletAppliedPaise: walletApplied,
        });
      }

      res.json({ mode: "simulated", amount: payable, walletAppliedPaise: walletApplied });
    } catch (err) {
      next(err);
    }
  },
);

// Simulated success — only exists while Cashfree keys are absent, never in prod.
paymentsRouter.post(
  "/simulate",
  validateBody(z.object({ orderId: z.string().cuid(), method: z.enum(["upi", "card"]) }).strict()),
  async (req, res, next) => {
    try {
      if (isProd || (cashfreeConfigured && !env.DEMO_PAYMENTS)) {
        throw new ApiError(403, "Simulated payments are disabled");
      }
      const { orderId, method } = req.body as { orderId: string; method: string };
      const order = await prisma.order.findFirst({
        where: { id: orderId, userId: req.userId! },
      });
      if (!order) throw new ApiError(404, "Order not found");
      const updated = await markPaid(orderId, method);
      res.json({ order: updated });
    } catch (err) {
      next(err);
    }
  },
);

// Verify-on-return: when the buyer lands back from the Cashfree checkout, the
// client calls this and WE ask Cashfree for the authoritative order state —
// payment confirmation never depends on the client's word, and works even if a
// webhook is delayed or misconfigured. Idempotent via markPaid's status claim.
paymentsRouter.post(
  "/verify",
  validateBody(z.object({ orderId: z.string().cuid() }).strict()),
  async (req, res, next) => {
    try {
      const { orderId } = req.body as { orderId: string };
      const order = await prisma.order.findFirst({
        where: { id: orderId, userId: req.userId! },
        include: { payment: true },
      });
      if (!order) throw new ApiError(404, "Order not found");

      // Nothing to verify in simulated mode, or when already settled.
      if (!cashfreeConfigured || order.status !== "pending_payment") {
        return res.json({ orderStatus: order.status });
      }

      // The pay screen calls this on every load to catch a buyer returning
      // from the gateway. For an order that has not been sent to Cashfree yet
      // — the normal case on first view — Cashfree answers 404. That is "not
      // paid", not a failure, and raising it made every payment page log a
      // server error and wait on a doomed round trip.
      let cf: Awaited<ReturnType<typeof getCashfreeOrder>>;
      try {
        cf = await getCashfreeOrder(orderId);
      } catch (err) {
        if (err instanceof Error && /\(404\)/.test(err.message)) {
          return res.json({ orderStatus: order.status, gatewayStatus: "NOT_CREATED" });
        }
        // Cashfree unreachable or failing. Whether this customer paid is
        // unknown, not failed, so the order stays as it is and the webhook
        // settles it when the gateway is back. This used to answer 500 to a
        // customer who may just have paid.
        console.warn(
          `[payments] could not reach the gateway to verify ${orderId}: ${err instanceof Error ? err.message : err}`,
        );
        return res.json({ orderStatus: order.status, gatewayStatus: "UNREACHABLE" });
      }

      if (cf.order_status === "PAID") {
        const updated = await markPaid(orderId, "cashfree", {
          paidPaise: Math.round(cf.order_amount * 100),
          gatewayResponse: JSON.stringify({ verifiedViaReturn: true, ...cf }),
        });
        return res.json({ orderStatus: updated?.status ?? "pending_payment" });
      }
      res.json({ orderStatus: order.status, gatewayStatus: cf.order_status });
    } catch (err) {
      next(err);
    }
  },
);

paymentsRouter.get("/status/:orderId", async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, userId: req.userId! },
      include: { payment: { select: { status: true, method: true } } },
    });
    if (!order) throw new ApiError(404, "Order not found");
    // Only offered while the order can still take it — a confirmed order's
    // balance is nobody's business on this screen.
    const balancePaise =
      order.status === "pending_payment" ? await walletBalance(req.userId!) : 0;
    res.json({
      orderStatus: order.status,
      payment: order.payment,
      amount: order.amount,
      // Gross bill vs. what the buyer still has to pay after reward credit.
      walletAppliedPaise: walletAppliedOn(order),
      payablePaise: payableOn(order),
      walletBalancePaise: balancePaise,
      title: order.title,
      domain: order.domain,
      provider: order.provider,
      savedPaise: order.savedPaise,
      // Bill breakdown for the payment "Order Summary" block.
      details: JSON.parse(order.details),
    });
  } catch (err) {
    next(err);
  }
});
