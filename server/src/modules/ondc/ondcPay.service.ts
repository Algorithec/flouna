import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { cashfreeConfigured, createCashfreeOrder, getCashfreeOrder } from "../payments/cashfree.js";
import { gatewayOrderId, ondcOrderIdFrom, owe } from "./ondcMoney.js";
import { billingFor, confirmOndcOrder, markOndcOrderPaid, type OrderDeps } from "./orders.service.js";
import { PROBLEM } from "./problems.js";

// Paying for an ONDC order. Flouna collects ("BAP" in the seller's terms):
// the customer pays the seller's final total through Cashfree, and once the
// gateway says it is paid the order is placed with the seller straight away,
// without waiting for the customer to come back to the app.
//
// Paid is decided by the gateway only: its signed webhook, or our own query
// to it when the customer returns. Never by the browser's word.

type Gateway = {
  create?: typeof createCashfreeOrder;
  get?: typeof getCashfreeOrder;
};

/** Starts (or resumes) a payment for the seller's final total. */
export async function startOndcPayment(userId: string, id: string, gw: Gateway = {}) {
  const order = await prisma.ondcOrder.findUnique({ where: { id } });
  if (!order || order.userId !== userId) throw new ApiError(404, "Order not found");
  if (order.status !== "ready_to_pay" || order.totalPaise == null) throw new ApiError(409, `This order is ${order.status}, not waiting for payment`);
  const terms = JSON.parse(order.payment ?? "{}") as { collectedBy?: string };
  if (terms.collectedBy !== "BAP") throw new ApiError(409, "This seller collects payment itself, which Flouna does not support yet");
  if (!cashfreeConfigured && !gw.create) throw new ApiError(503, "Online payment is not set up on this deployment");
  const b = await billingFor(order);
  const cfId = gatewayOrderId(order.id);
  let session: { payment_session_id: string; amountPaise: number };
  try {
    const cf = await (gw.create ?? createCashfreeOrder)({
      orderId: cfId,
      amountPaise: order.totalPaise,
      customerId: order.userId,
      customerEmail: b.email,
      customerPhone: b.phone,
      returnUrl: `${env.CASHFREE_RETURN_ORIGIN ?? env.WEB_ORIGIN}/food/ondc/${order.id}?from=cashfree`,
    });
    session = { payment_session_id: cf.payment_session_id, amountPaise: order.totalPaise };
  } catch (err) {
    // A second tap: the gateway already has this order. Its session is reused
    // only if it charges the same total, never a number the customer was not shown.
    if ((err as { cfStatus?: number }).cfStatus !== 409) throw err;
    const cf = await (gw.get ?? getCashfreeOrder)(cfId);
    if (cf.order_status === "PAID") throw new ApiError(409, "This order is already paid");
    if (Math.round(cf.order_amount * 100) !== order.totalPaise) throw new ApiError(409, "The total changed after payment started. Start the order again.");
    session = { payment_session_id: cf.payment_session_id, amountPaise: order.totalPaise };
  }
  return { paymentSessionId: session.payment_session_id, amountPaise: session.amountPaise, environment: env.CASHFREE_ENV };
}

/**
 * The gateway says this ONDC order was paid. Idempotent: webhooks repeat, and
 * the return check may race the webhook. Money that cannot buy the order (the
 * amount differs, or the order moved on) is recorded as owed back at once.
 */
export async function settleOndcPayment(gatewayId: string, paidPaise: number, reference: string, deps: OrderDeps = {}) {
  const id = ondcOrderIdFrom(gatewayId);
  if (!id) return { handled: false as const };
  const order = await prisma.ondcOrder.findUnique({ where: { id } });
  if (!order) return { handled: true as const, outcome: "unknown_order" as const };
  if (order.paidAt) return { handled: true as const, outcome: "already_paid" as const };

  if (order.status === "ready_to_pay" && paidPaise === order.totalPaise) {
    try {
      await markOndcOrderPaid(order.id, { amountPaise: paidPaise, reference });
    } catch {
      // Lost a race with a second delivery of the same payment.
      return { handled: true as const, outcome: "already_paid" as const };
    }
    await confirmOndcOrder(order.userId, order.id, deps).catch(async (err: unknown) => {
      // Paid and recorded; placing it can be retried from the app, which
      // offers that only when the order says why it is stuck.
      console.error("[ondc] could not place paid order", order.id, err instanceof Error ? err.message : String(err));
      await prisma.ondcOrder.updateMany({
        where: { id: order.id, status: "paid", problem: null },
        data: { problem: PROBLEM.paidNotPlaced },
      });
    });
    return { handled: true as const, outcome: "placed" as const };
  }

  // Paid, but not for this order as it stands: the total changed, or it is no
  // longer waiting for payment. The money goes back in full.
  const took = await prisma.ondcOrder.updateMany({
    where: { id: order.id, paidAt: null },
    data: {
      paidAt: new Date(),
      paidPaise,
      paymentRef: reference,
      status: "failed",
      problem: paidPaise === order.totalPaise ? "The order changed before the payment arrived, so it was refunded" : "The amount paid did not match the order, so it was refunded",
    },
  });
  if (took.count === 1) await owe(order.id, { paise: paidPaise });
  return { handled: true as const, outcome: "refunded" as const };
}

/** The customer is back from the gateway: ask the gateway, not the browser, whether they paid. */
export async function verifyOndcPayment(userId: string, id: string, gw: Gateway = {}, deps: OrderDeps = {}) {
  const order = await prisma.ondcOrder.findUnique({ where: { id } });
  if (!order || order.userId !== userId) throw new ApiError(404, "Order not found");
  if (order.paidAt || (!cashfreeConfigured && !gw.get)) return { status: order.status };
  let cf;
  try {
    cf = await (gw.get ?? getCashfreeOrder)(gatewayOrderId(order.id));
  } catch (err) {
    if (err instanceof Error && /\(404\)/.test(err.message)) return { status: order.status, gateway: "NOT_CREATED" };
    // Unknown, not failed: the webhook settles it when the gateway is back.
    return { status: order.status, gateway: "UNREACHABLE" };
  }
  if (cf.order_status === "PAID") {
    await settleOndcPayment(gatewayOrderId(order.id), Math.round(cf.order_amount * 100), cf.cf_order_id, deps);
    const now = await prisma.ondcOrder.findUniqueOrThrow({ where: { id } });
    return { status: now.status };
  }
  return { status: order.status, gateway: cf.order_status };
}
