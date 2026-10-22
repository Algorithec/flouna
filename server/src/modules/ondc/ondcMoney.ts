import { prisma } from "../../lib/prisma.js";
import { cashfreeConfigured, createCashfreeRefund } from "../payments/cashfree.js";
import { commercialTerms } from "./commercial.js";
import type { PaymentTerms } from "./orderReplies.js";

// The money side of an ONDC order Flouna collected for: what goes back to the
// customer, and what goes on to the seller app.
//
// Refunds follow one rule: the customer gets back what they paid less what
// the seller finally charged. A seller that cancels, or never accepts, charges
// nothing. When the amount cannot be worked out from the seller's own reply,
// it waits for a person ("review") rather than refund a guess.
//
// Payouts are only recorded here. An operator sends the transfer and records
// its bank reference: with no reserves to absorb it, a bug that paid a seller
// twice is the worst thing this code could do, so it cannot.

/** The gateway order id for an ONDC order. Prefixed so the webhook can tell them apart. */
export const gatewayOrderId = (ondcOrderId: string) => `ondc_${ondcOrderId}`;
export const ondcOrderIdFrom = (gatewayId: string) => (gatewayId.startsWith("ondc_") ? gatewayId.slice(5) : null);

type Refund = { paise: number } | { review: string };

/**
 * Records money owed back. Idempotent against duplicate seller callbacks,
 * but a concrete refund (cancellation) supersedes a pending review (bill
 * reduction) so that a cancel-after-reduction doesn't silently drop money.
 */
export async function owe(ondcOrderId: string, refund: Refund) {
  const data =
    "paise" in refund
      ? refund.paise > 0
        ? { refundPaise: refund.paise, refundStatus: "owed" }
        : { refundPaise: 0, refundStatus: "done" }
      : { refundStatus: "review", problem: refund.review };
  const fresh = await prisma.ondcOrder.updateMany({ where: { id: ondcOrderId, refundStatus: null, paidAt: { not: null } }, data });
  if (fresh.count === 0 && "paise" in refund && refund.paise > 0) {
    await prisma.ondcOrder.updateMany({
      where: { id: ondcOrderId, refundStatus: "review", paidAt: { not: null } },
      data,
    });
  }
  await sendRefund(ondcOrderId);
}

/** What a cancelled, paid order owes back, from the seller's own last word on it. */
export function refundAfterCancel(o: { paidPaise: number; cancelledBySeller: boolean; finalTotalPaise?: number }): Refund {
  if (o.cancelledBySeller) return { paise: o.paidPaise };
  if (o.finalTotalPaise === undefined) return { review: "The seller cancelled without a final bill, so the refund needs checking" };
  if (o.finalTotalPaise > o.paidPaise) return { review: "The seller's final bill is more than was paid" };
  return { paise: o.paidPaise - o.finalTotalPaise };
}

/**
 * Sends an owed refund to the gateway. The refund id is fixed per order, and
 * Cashfree refuses a second refund with the same id, so a retry or a race can
 * never move money twice.
 */
export async function sendRefund(ondcOrderId: string, deps: { refund?: typeof createCashfreeRefund } = {}) {
  const claimed = await prisma.ondcOrder.updateMany({ where: { id: ondcOrderId, refundStatus: "owed" }, data: { refundStatus: "requested" } });
  if (claimed.count === 0) return;
  const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: ondcOrderId } });
  if (order.refundPaise == null || order.refundPaise <= 0) {
    await prisma.ondcOrder.update({ where: { id: order.id }, data: { refundStatus: "done", refundRef: "zero_refund" } });
    return;
  }
  // Demo payments took no money, so there is nothing to send back.
  if (order.paymentRef?.startsWith("demo_") || (!cashfreeConfigured && !deps.refund)) {
    await prisma.ondcOrder.update({ where: { id: order.id }, data: { refundStatus: "done", refundRef: "no_gateway" } });
    return;
  }
  try {
    const r = await (deps.refund ?? createCashfreeRefund)({
      orderId: gatewayOrderId(order.id),
      refundId: `${gatewayOrderId(order.id)}_refund_${order.refundPaise}`,
      amountRupees: order.refundPaise / 100,
      note: "Refund for an ONDC order",
    });
    await prisma.ondcOrder.update({ where: { id: order.id }, data: { refundStatus: "done", refundRef: String(r.cf_refund_id) } });
  } catch (err) {
    console.error("[ondc] refund failed for", order.id, err instanceof Error ? err.message : String(err));
    await prisma.ondcOrder.update({ where: { id: order.id }, data: { refundStatus: "failed" } });
  }
}

/** "P3D", "PT12H" to milliseconds; anything else to null. */
export function durationMs(iso: string | null | undefined): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso ?? "");
  if (!m || iso === "P" || iso === "PT") return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
}

/**
 * Records what Flouna owes the seller app for a delivered order. Once per
 * order (the row is unique on it). Only for orders Flouna collected for.
 */
export async function recordPayout(ondcOrderId: string, completedAt: Date) {
  const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: ondcOrderId } });
  if (!order.paidAt || !order.payment || order.totalPaise == null) return;
  const terms = JSON.parse(order.payment) as PaymentTerms & { settlementWindow?: string; settlementBasis?: string };
  if (terms.collectedBy !== "BAP") return;
  const percent = Number(terms.finderFee ?? commercialTerms().finderFeePercent);
  const clampedPercent = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
  const fee = Math.round((order.totalPaise * clampedPercent) / 100);
  // The window is counted from delivery. A basis of return_window_expiry means
  // the seller expects it after its return window too, which the order does
  // not carry, so those are held for an operator to date.
  const windowMs = durationMs(terms.settlementWindow) ?? 3 * 86_400_000;
  const held = terms.settlementBasis === "return_window_expiry";
  await prisma.ondcPayout
    .create({
      data: {
        ondcOrderId: order.id,
        bppId: order.bppId,
        orderTotalPaise: order.totalPaise,
        feePaise: fee,
        amountPaise: order.totalPaise - fee,
        settlement: JSON.stringify(terms.settlementDetails),
        settlementWindow: terms.settlementWindow ?? null,
        settlementBasis: terms.settlementBasis ?? null,
        dueAt: new Date(completedAt.getTime() + windowMs),
        status: held ? "held" : "due",
        note: held ? "Due after the seller's return window ends; check the item's return window before paying" : null,
      },
    })
    .catch((err: { code?: string }) => {
      if (err.code !== "P2002") throw err;
    });
}

/** Payouts for the operator's screen, soonest first. */
export function payoutsDue(now = new Date()) {
  return prisma.ondcPayout.findMany({ where: { status: { in: ["due", "held"] } }, orderBy: { dueAt: "asc" } }).then((rows) =>
    rows.map((r) => ({ ...r, settlement: JSON.parse(r.settlement) as unknown, overdue: r.status === "due" && r.dueAt < now })),
  );
}

/** Records a transfer the operator made. Refuses a second record for the same payout. */
export async function markPayoutPaid(id: string, by: string, utr: string) {
  const done = await prisma.ondcPayout.updateMany({
    where: { id, status: { in: ["due", "held"] } },
    data: { status: "paid", paidAt: new Date(), utr, paidBy: by },
  });
  return done.count === 1;
}

/**
 * Refunds a person has to look at: amounts the seller's reply did not
 * settle, gateway failures, and any sent to the gateway that never came back
 * (the server stopped between claiming one and hearing the answer). Those
 * are checked in Cashfree before anything is done: the refund may well have
 * gone through.
 */
export function refundsNeedingAttention(now = new Date()) {
  return prisma.ondcOrder.findMany({
    where: {
      OR: [
        { refundStatus: { in: ["review", "failed"] } },
        { refundStatus: "requested", updatedAt: { lt: new Date(now.getTime() - 15 * 60_000) } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    select: { id: true, storeName: true, paidPaise: true, totalPaise: true, refundPaise: true, refundStatus: true, problem: true, sellerState: true, updatedAt: true },
  });
}

/**
 * An operator settles a refund under review at an amount no more than was
 * paid, or sends a failed one again. Either way the gateway call goes through
 * sendRefund, with its fixed refund id.
 */
export async function resolveRefund(id: string, opts: { paise: number } | { retry: true }) {
  if ("retry" in opts) {
    const moved = await prisma.ondcOrder.updateMany({ where: { id, refundStatus: "failed" }, data: { refundStatus: "owed" } });
    if (moved.count === 0) return false;
  } else {
    const order = await prisma.ondcOrder.findUnique({ where: { id }, select: { paidPaise: true } });
    if (!order?.paidPaise || !Number.isSafeInteger(opts.paise) || opts.paise < 0 || opts.paise > order.paidPaise) return false;
    const moved = await prisma.ondcOrder.updateMany({
      where: { id, refundStatus: "review" },
      data: opts.paise > 0 ? { refundStatus: "owed", refundPaise: opts.paise } : { refundStatus: "done", refundPaise: 0 },
    });
    if (moved.count === 0) return false;
  }
  await sendRefund(id);
  return true;
}
