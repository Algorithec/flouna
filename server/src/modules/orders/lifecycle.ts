import { prisma } from "../../lib/prisma.js";
import { getConfig } from "../backoffice/config.service.js";
import { creditCashback } from "../users/wallet.service.js";

/**
 * Lazy lifecycle completion: once every step of a confirmed order's tracking
 * timeline has passed, the order is completed the next time anything looks at
 * it (real ONDC status updates replace this).
 *
 * Only the order screen used to look. An order whose screen was closed before
 * its last step stayed "confirmed" for good: the history listed it as still
 * going and left it out of "Completed", and the support assistant greeted the
 * customer weeks later with an order "being prepared". Everything that shows a
 * customer their orders now finishes the due ones first.
 */

type Completable = {
  id: string;
  userId: string;
  amount: number;
  title: string;
  payment: { status: string } | null;
};

/** Whether a confirmed order's timeline has run out. */
export function timelineElapsed(
  order: { status: string; trackingEvents: { createdAt: Date }[] },
  now = new Date(),
) {
  return (
    order.status === "confirmed" &&
    order.trackingEvents.length > 0 &&
    order.trackingEvents.every((e) => e.createdAt <= now)
  );
}

/** Completes one order and pays its cashback. False if something else changed it first. */
export async function completeOrder(order: Completable): Promise<boolean> {
  // Only if it is still confirmed. This write used to be unconditional,
  // so a cancellation landing between the read and this line was
  // overwritten: the order showed completed with a refund flagged against
  // it and cashback paid on it.
  const completed = await prisma.order.updateMany({
    where: { id: order.id, status: "confirmed" },
    data: { status: "completed" },
  });
  if (completed.count === 0) return false;

  // Completing the order is what earns the buyer's cashback. The rate is
  // the platform's own configured numbers (the ONDC margin floor, and the
  // share of it handed back), so nothing about the reward is invented here.
  // The ledger's unique index makes a repeat call a no-op, which matters
  // because the order screen polls.
  //
  // Only on money actually collected. Cash on delivery confirms the order
  // and leaves its payment at "pending" until the money is taken in
  // person, and nothing ever marks it taken, so every COD order reached
  // here and paid out a share of a margin Flouna had not earned. A buyer
  // could place COD orders, refuse them at the door, and still be credited
  // real spendable balance. The cashback follows the payment, and a COD
  // order earns it once collection is recorded.
  const paid = order.payment?.status === "success";
  const { ondcMinMarginBps, cashbackUserSharePct } = await getConfig();
  if (paid && cashbackUserSharePct > 0) {
    await creditCashback({
      userId: order.userId,
      orderId: order.id,
      marginPaise: Math.floor((order.amount * ondcMinMarginBps) / 10_000),
      title: order.title,
    }).catch(() => {
      // A reward must never break the order it rewards.
    });
  }
  return true;
}

/** Completes every one of a customer's orders whose timeline has run out. */
export async function completeDueOrders(userId: string, now = new Date()) {
  const due = await prisma.order.findMany({
    where: {
      userId,
      status: "confirmed",
      AND: [
        { trackingEvents: { some: {} } },
        { trackingEvents: { none: { createdAt: { gt: now } } } },
      ],
    },
    select: {
      id: true,
      userId: true,
      amount: true,
      title: true,
      payment: { select: { status: true } },
    },
  });
  for (const order of due) await completeOrder(order);
}
