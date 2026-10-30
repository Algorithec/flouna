import { prisma } from "../../lib/prisma.js";
import { cashfreeConfigured, createCashfreeRefund } from "../payments/cashfree.js";
import { commercialTerms } from "./commercial.js";
import type { PaymentTerms } from "./orderReplies.js";
import { PROBLEM } from "./problems.js";

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
 * Records money owed back. `paise` is the total the customer should have
 * back from this order, not a top up: a cancellation after a partial refund
 * names the whole amount, and only what has not gone back yet is sent.
 *
 * It used to record one refund per order. Once that one had gone through, a
 * later cancellation, or a second cut to the bill, was dropped, and the
 * customer never got that money back.
 */
export async function owe(ondcOrderId: string, refund: Refund) {
  if ("paise" in refund) {
    // What is due only grows, so a repeated or older callback with a smaller
    // figure changes nothing.
    if (refund.paise > 0) {
      await prisma.ondcOrder.updateMany({
        where: { id: ondcOrderId, paidAt: { not: null }, OR: [{ refundDuePaise: null }, { refundDuePaise: { lt: refund.paise } }] },
        data: { refundDuePaise: refund.paise },
      });
    }
    // Sent now unless a refund is already on its way: that one checks for
    // more due when it finishes. A concrete amount supersedes a review.
    await prisma.ondcOrder.updateMany({
      where: { id: ondcOrderId, paidAt: { not: null }, OR: [{ refundStatus: null }, { refundStatus: { in: ["review", "done", "failed"] } }] },
      data: { refundStatus: "owed" },
    });
  } else {
    // A person decides the amount, also after an earlier refund finished.
    await prisma.ondcOrder.updateMany({
      where: { id: ondcOrderId, paidAt: { not: null }, OR: [{ refundStatus: null }, { refundStatus: { in: ["review", "done"] } }] },
      data: { refundStatus: "review", problem: refund.review },
    });
  }
  await sendRefund(ondcOrderId);
}

/** What a cancelled, paid order owes back, from the seller's own last word on it. */
export function refundAfterCancel(o: { paidPaise: number; cancelledBySeller: boolean; finalTotalPaise?: number }): Refund {
  if (o.cancelledBySeller) return { paise: o.paidPaise };
  if (o.finalTotalPaise === undefined) return { review: PROBLEM.refundNoBill };
  if (o.finalTotalPaise > o.paidPaise) return { review: PROBLEM.refundOverBill };
  return { paise: o.paidPaise - o.finalTotalPaise };
}

/** Takes an owed refund for sending. Only one caller can hold an order at a time. */
async function claimRefund(ondcOrderId: string): Promise<boolean> {
  const claimed = await prisma.ondcOrder.updateMany({ where: { id: ondcOrderId, refundStatus: "owed" }, data: { refundStatus: "requested" } });
  return claimed.count === 1;
}

/**
 * Sends what is owed and not yet refunded to the gateway. The refund id names
 * the step (what had gone back before, and this amount): Cashfree refuses a
 * second refund with the same id, so a retry or a race can never move money
 * twice, while a later refund on the same order gets an id of its own.
 *
 * One step per pass. A pass hands the order back as owed only when more came
 * due while its step was with the gateway, so the loop ends as soon as nothing
 * more is owed, a step fails, or another caller has taken the order.
 */
export async function sendRefund(ondcOrderId: string, deps: { refund?: typeof createCashfreeRefund } = {}): Promise<void> {
  while (await claimRefund(ondcOrderId)) {
    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: ondcOrderId } });
    // Due less refunded. A row from before refunds were counted carries only
    // the amount of its one refund.
    const amount = order.refundDuePaise != null ? order.refundDuePaise - order.refundedPaise : (order.refundPaise ?? 0);
    if (amount <= 0) {
      await prisma.ondcOrder.update({ where: { id: order.id }, data: { refundStatus: "done" } });
      return;
    }
    const finished = (ref: string) =>
      prisma.ondcOrder.updateMany({
        where: { id: order.id, refundStatus: "requested" },
        data: { refundStatus: "done", refundRef: ref, refundPaise: amount, refundedPaise: { increment: amount } },
      });
    // Demo payments took no money, so there is nothing to send back.
    if (order.paymentRef?.startsWith("demo_") || (!cashfreeConfigured && !deps.refund)) {
      if ((await finished("no_gateway")).count) await holdSellerMoneyAfterRefund(order.id, amount);
    } else {
      try {
        const r = await (deps.refund ?? createCashfreeRefund)({
          orderId: gatewayOrderId(order.id),
          refundId: `${gatewayOrderId(order.id)}_refund_${order.refundedPaise}_${amount}`,
          amountRupees: amount / 100,
          note: "Refund for an ONDC order",
        });
        if ((await finished(String(r.cf_refund_id))).count) await holdSellerMoneyAfterRefund(order.id, amount);
      } catch (err) {
        console.error("[ondc] refund failed for", order.id, err instanceof Error ? err.message : String(err));
        await prisma.ondcOrder.update({ where: { id: order.id }, data: { refundStatus: "failed", refundPaise: amount } });
        return;
      }
    }
    // More may have come due while this one was on its way.
    const after = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: order.id }, select: { refundDuePaise: true, refundedPaise: true } });
    if (after.refundDuePaise == null || after.refundDuePaise <= after.refundedPaise) return;
    await prisma.ondcOrder.updateMany({ where: { id: order.id, refundStatus: "done" }, data: { refundStatus: "owed" } });
  }
}

const rupees = (paise: number) => (paise / 100).toFixed(2);

/**
 * A refund after the order completed (a return, or a complaint resolved with
 * money back) comes out of what the seller is owed. The customer is refunded
 * at once from the money Flouna holds; the seller's share then has to shrink
 * by the same amount, and nothing did that. A payout or settlement still
 * waiting would have been paid in full, so Flouna paid the refund twice over:
 * once to the customer and again inside the seller's money.
 *
 * So a payout or settlement not yet paid is held, with a note saying how much
 * to take off, for the operator who already decides every payout. One already
 * paid is flagged for recovery from the seller, loudly, as a double payment is.
 * Nothing is re-calculated here: how a refund splits between the seller's
 * share and our fee is a decision for a person, not a guess in code.
 *
 * Before completion there is neither row, and the seller's final bill already
 * gives a lower total, so a cancellation needs none of this.
 */
async function holdSellerMoneyAfterRefund(ondcOrderId: string, refundedPaise: number): Promise<void> {
  const reduce = `Customer refunded Rs ${rupees(refundedPaise)} after the order completed: take it off before paying the seller.`;
  const recover = `RECOVER: customer refunded Rs ${rupees(refundedPaise)} after the seller was paid. Recover it from the seller.`;
  const withNote = (note: string | null, add: string) => (note ? `${note} ${add}` : add);

  // Each row is re-read if it changed under us, for instance an operator
  // marking the payout paid at the same moment, so the note is never lost.
  for (let attempt = 0; attempt < 3; attempt++) {
    const payout = await prisma.ondcPayout.findUnique({ where: { ondcOrderId } });
    if (!payout) break;
    const waiting = payout.status === "due" || payout.status === "held";
    const done = await prisma.ondcPayout.updateMany({
      where: { id: payout.id, status: payout.status, note: payout.note },
      data: waiting ? { status: "held", note: withNote(payout.note, reduce) } : { note: withNote(payout.note, recover) },
    });
    if (!done.count) continue;
    if (!waiting) console.error("[ondc] refund after the seller was paid by hand, order", ondcOrderId);
    break;
  }

  // Only where Flouna collected: when the seller collected, the seller
  // refunds the customer itself and owes us only the fee.
  for (let attempt = 0; attempt < 3; attempt++) {
    const settlement = await prisma.ondcSettlement.findUnique({ where: { ondcOrderId } });
    if (!settlement || settlement.role !== "collector") break;
    const waiting = settlement.status === "due" || settlement.status === "held";
    const done = await prisma.ondcSettlement.updateMany({
      where: { id: settlement.id, status: settlement.status, note: settlement.note },
      data: waiting ? { status: "held", note: withNote(settlement.note, reduce) } : { note: withNote(settlement.note, recover) },
    });
    if (!done.count) continue;
    if (!waiting) console.error("[ondc] refund after the seller was settled, order", ondcOrderId);
    break;
  }
}

/**
 * The Buyer Finder Fee on an order, in paise, as the seller agreed it in
 * on_init: a percentage of the order total, or a fixed amount. Never more
 * than the order, never negative: a misconfigured fee must not turn into a
 * payout larger than the money taken, or a negative one.
 */
export function finderFeePaise(totalPaise: number, terms: { finderFee?: string; finderFeeType?: string }): number {
  if (terms.finderFeeType === "amount") {
    const v = terms.finderFee?.trim();
    const paise = v && /^\d+(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : 0;
    return Math.min(paise, totalPaise);
  }
  const percent = Number(terms.finderFee ?? commercialTerms().finderFeePercent);
  const clamped = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
  return Math.round((totalPaise * clamped) / 100);
}

/**
 * "P3D", "PT12H", "PT30S" to milliseconds; anything else to null. "P200S",
 * which ONDC's own examples write for 200 seconds, is read as that too. The
 * T stays required for hours and minutes: without it "P1M" is a month.
 */
export function durationMs(iso: string | null | undefined): number | null {
  const loose = /^P(\d+)S$/i.exec(iso ?? "");
  if (loose) return Number(loose[1]) * 1000;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso ?? "");
  if (!m || iso === "P" || iso === "PT") return null;
  return (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60 + Number(m[4] ?? 0)) * 1000;
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
  const fee = finderFeePaise(order.totalPaise, terms);
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
    select: { id: true, storeName: true, paidPaise: true, totalPaise: true, refundPaise: true, refundedPaise: true, refundStatus: true, problem: true, sellerState: true, updatedAt: true },
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
    const order = await prisma.ondcOrder.findUnique({ where: { id }, select: { paidPaise: true, refundedPaise: true } });
    // No more than has not gone back already.
    if (!order?.paidPaise || !Number.isSafeInteger(opts.paise) || opts.paise < 0 || opts.paise > order.paidPaise - order.refundedPaise) return false;
    const moved = await prisma.ondcOrder.updateMany({
      where: { id, refundStatus: "review", refundedPaise: order.refundedPaise },
      data: { refundStatus: "owed", refundDuePaise: order.refundedPaise + opts.paise },
    });
    if (moved.count === 0) return false;
  }
  await sendRefund(id);
  return true;
}
