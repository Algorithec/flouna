import { prisma } from "../../lib/prisma.js";

// ONDC orders that asked a seller something and heard nothing back.
//
// Every step of an order (select, init, confirm, cancel) is acknowledged at
// once and answered later by the seller's own call. A seller that
// acknowledges and never answers leaves the order waiting for good: the app
// shows a spinner, and after a confirm the customer's money sits with no
// order behind it. Nothing moved such an order on, and nothing told anyone.
//
// This only finds them, for the console and the alerts feed. What to do
// about one (ask the seller, place it again, or refund) is a person's call:
// a confirm the seller did act on but never answered is a real order, and
// refunding it on a timer would give the food away.

/** How long each step may wait for the seller before somebody should look. */
export const WAIT_LIMIT_MS = {
  selecting: 5 * 60_000,
  initialising: 5 * 60_000,
  confirming: 10 * 60_000,
  cancelling: 30 * 60_000,
} as const;

export type WaitingOrder = {
  id: string;
  status: keyof typeof WAIT_LIMIT_MS;
  store: string;
  bppId: string;
  waitingMinutes: number;
  /** What the customer paid, when they have: the case that matters most. */
  paidPaise: number | null;
};

/** Orders waiting on a seller past their step's limit, longest first. */
export async function ordersWaitingOnSeller(now = new Date()): Promise<WaitingOrder[]> {
  const shortest = Math.min(...Object.values(WAIT_LIMIT_MS));
  const rows = await prisma.ondcOrder.findMany({
    where: {
      status: { in: Object.keys(WAIT_LIMIT_MS) },
      awaitingMsgId: { not: null },
      // updatedAt moves when the step is sent, and again on any answer.
      updatedAt: { lt: new Date(now.getTime() - shortest) },
    },
    orderBy: { updatedAt: "asc" },
    take: 100,
    select: { id: true, status: true, storeName: true, bppId: true, updatedAt: true, paidPaise: true },
  });
  return rows
    .filter((r) => now.getTime() - r.updatedAt.getTime() > WAIT_LIMIT_MS[r.status as keyof typeof WAIT_LIMIT_MS])
    .map((r) => ({
      id: r.id,
      status: r.status as keyof typeof WAIT_LIMIT_MS,
      store: r.storeName,
      bppId: r.bppId,
      waitingMinutes: Math.floor((now.getTime() - r.updatedAt.getTime()) / 60_000),
      // Set only once a payment is recorded.
      paidPaise: r.paidPaise,
    }));
}
