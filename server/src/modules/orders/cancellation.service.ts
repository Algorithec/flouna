// The cancellation and refund terms, applied to one order.
//
// Refund policy 2.2 to 2.4. The policy makes three distinct promises and the
// app was keeping none of them explicitly:
//
//   before payment      cancel freely, nothing charged
//   within 5 minutes    cancel in the app, refunded in full, no questions
//   after that          the seller's terms govern, and we pass the request on
//
// The window matters because it is the one part a customer is told they can
// rely on. Deciding it at the moment of cancellation, from the payment time,
// means it cannot drift with how long a screen sat open.

import { FREE_CANCEL_WINDOW_MS, REFUND_TIMELINE } from "../../lib/policy.js";

export type CancellationTerms = {
  /** Whether the order can be cancelled from the app at all. */
  cancellable: boolean;
  /** Inside the published no-questions window. */
  freeWindow: boolean;
  /** Milliseconds of that window left, floored at zero. */
  windowRemainingMs: number;
  /** True when nothing has been charged yet, so there is nothing to refund. */
  unpaid: boolean;
  /** What the customer should expect, in plain words. */
  summary: string;
};

type OrderLike = {
  status: string;
  domain: string;
  createdAt: Date;
};

type PaymentLike = {
  status: string;
  method: string | null;
  createdAt: Date;
  /** When the money was taken; absent on payments made before it was recorded. */
  paidAt?: Date | null;
} | null;

/**
 * Refund wait for a payment method, as the policy publishes it.
 *
 * Falls back to the widest published range rather than the narrowest. Telling
 * someone "1 to 2 days" and taking seven is a broken promise; telling them
 * "5 to 7" and taking two is a pleasant surprise.
 */
export function refundWindowDays(method: string | null): readonly [number, number] {
  const key = (method ?? "").toLowerCase();
  if (key.includes("upi")) return REFUND_TIMELINE.byMethodDays.upi;
  if (key.includes("card")) return REFUND_TIMELINE.byMethodDays.card;
  if (key.includes("wallet")) return REFUND_TIMELINE.byMethodDays.wallet;
  if (key.includes("net")) return REFUND_TIMELINE.byMethodDays.netbanking;
  return REFUND_TIMELINE.byMethodDays.netbanking;
}

/**
 * Works out where an order stands against the published terms.
 *
 * The clock starts at payment, not at order creation. Someone who sat on a
 * checkout screen for ten minutes before paying has not used up a window that
 * the policy measures from "after payment", and starting it earlier would
 * silently take their five minutes away.
 */
export function cancellationTerms(
  order: OrderLike,
  payment: PaymentLike,
  now = new Date(),
): CancellationTerms {
  const terminal = order.status === "completed" || order.status === "cancelled";
  const paid = payment?.status === "success" || payment?.status === "refund_pending";

  if (terminal) {
    return {
      cancellable: false,
      freeWindow: false,
      windowRemainingMs: 0,
      unpaid: !paid,
      summary:
        order.status === "cancelled"
          ? "This order is already cancelled."
          : "This order is complete and can no longer be cancelled.",
    };
  }

  if (!paid) {
    return {
      cancellable: true,
      freeWindow: true,
      windowRemainingMs: FREE_CANCEL_WINDOW_MS,
      unpaid: true,
      summary: "Nothing has been charged yet. Cancelling costs you nothing.",
    };
  }

  // From the moment of payment. The row's createdAt is when checkout began,
  // so measuring from it took the window away from anyone slow to pay.
  const paidAt = payment!.paidAt ?? payment!.createdAt;
  const since = now.getTime() - paidAt.getTime();
  const remaining = Math.max(0, FREE_CANCEL_WINDOW_MS - since);
  const [lo, hi] = refundWindowDays(payment!.method);

  if (remaining > 0) {
    return {
      cancellable: true,
      freeWindow: true,
      windowRemainingMs: remaining,
      unpaid: false,
      summary: `Cancel now and you are refunded in full, with no questions asked. The money reaches you in ${lo} to ${hi} days.`,
    };
  }

  return {
    cancellable: true,
    freeWindow: false,
    windowRemainingMs: 0,
    unpaid: false,
    // Deliberately does not promise a full refund. Past the window the seller's
    // terms govern, and promising something we do not control is how a support
    // queue fills with people who were told the wrong thing by the app.
    summary: `The free cancellation window has passed, so the seller's own terms now apply and a fee may be charged. We will pass your request on. Any refund reaches you in ${lo} to ${hi} days.`,
  };
}
