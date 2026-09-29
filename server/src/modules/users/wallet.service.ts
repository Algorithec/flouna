import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { getConfig } from "../backoffice/config.service.js";

// Rewards wallet.
//
// The balance is always SUM(amountPaise) over the ledger, never a stored
// column: a column would be a second source of truth that can drift from the
// events that produced it, and money that disagrees with its own history is
// worse than no feature at all.
//
// The earning rule is not invented here. `cashbackUserSharePct` already exists
// in platform config — the share of Flouna's own margin handed back to the
// buyer — set by a super admin and defaulting to 30%. Until now nothing read
// it; this is what spends it.

/** Signed sum of the ledger. Never negative in practice — spends are checked. */
export async function walletBalance(userId: string) {
  const agg = await prisma.walletEntry.aggregate({
    where: { userId },
    _sum: { amountPaise: true },
  });
  return agg._sum.amountPaise ?? 0;
}

export async function walletHistory(userId: string, take = 50) {
  return prisma.walletEntry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      amountPaise: true,
      reason: true,
      description: true,
      orderId: true,
      createdAt: true,
    },
  });
}

/**
 * Credits the buyer's share of the margin on a completed order.
 *
 * Idempotent by construction: the ledger has a unique index on
 * (userId, orderId, reason), so a retried webhook or a second call for the same
 * order cannot pay the cashback twice. A duplicate is swallowed rather than
 * thrown, because the caller's job (completing an order) has already succeeded
 * and must not fail on a reward that was already granted.
 */
export async function creditCashback(opts: {
  userId: string;
  orderId: string;
  /** What Flouna actually earned on this order, in paise. */
  marginPaise: number;
  title?: string;
}) {
  if (opts.marginPaise <= 0) return null;
  const { cashbackUserSharePct } = await getConfig();
  if (cashbackUserSharePct <= 0) return null;

  const amountPaise = Math.floor((opts.marginPaise * cashbackUserSharePct) / 100);
  if (amountPaise <= 0) return null;

  try {
    return await prisma.walletEntry.create({
      data: {
        userId: opts.userId,
        orderId: opts.orderId,
        amountPaise,
        reason: "cashback",
        description: opts.title
          ? `Cashback on ${opts.title}`
          : "Cashback on your order",
      },
    });
  } catch {
    // Unique constraint — already credited for this order.
    return null;
  }
}

/**
 * Spends wallet credit. Returns the amount actually taken, which may be less
 * than requested when the balance is short.
 *
 * Serializable, and retried when the database refuses a conflicting commit.
 *
 * The balance is re-summed inside the transaction that writes the debit, and
 * this used to claim that was enough to stop two spends of the same rupees.
 * It is on SQLite, which only ever lets one writer in. Production is Postgres
 * at read committed, where two checkouts for different orders each sum the
 * same balance, neither sees the other's uncommitted debit, and both commit:
 * run against a real Postgres, 39 of 40 such pairs spent ₹100 twice and left
 * the wallet at minus ₹100. The per-order unique index cannot help, because
 * the two debits belong to different orders.
 *
 * Serializable makes Postgres abort one of the pair instead, and the retry
 * then sees the committed debit and takes only what is left. SQLite supports
 * only this level, so the same code runs on both.
 *
 * A second spend for the same order returns the first rather than failing on
 * the unique index. A retried checkout, or one that crashed after debiting and
 * before recording the debit on the order, then finds the money it already
 * took instead of erroring for ever.
 */
const SPEND_ATTEMPTS = 5;

export async function spendFromWallet(opts: {
  userId: string;
  orderId: string;
  /** Most the caller is willing to take — usually the order total. */
  maxPaise: number;
  description?: string;
}) {
  if (opts.maxPaise <= 0) return 0;

  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const already = await tx.walletEntry.findUnique({
            where: {
              userId_orderId_reason: {
                userId: opts.userId,
                orderId: opts.orderId,
                reason: "spend",
              },
            },
            select: { amountPaise: true },
          });
          if (already) return -already.amountPaise;

          const agg = await tx.walletEntry.aggregate({
            where: { userId: opts.userId },
            _sum: { amountPaise: true },
          });
          const balance = agg._sum.amountPaise ?? 0;
          const take = Math.min(balance, opts.maxPaise);
          if (take <= 0) return 0;

          await tx.walletEntry.create({
            data: {
              userId: opts.userId,
              orderId: opts.orderId,
              amountPaise: -take,
              reason: "spend",
              description: opts.description ?? "Applied to your order",
            },
          });
          return take;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      // P2034: the database aborted this transaction to keep the two apart.
      // Nothing was written, so running it again is safe.
      if ((err as { code?: string }).code === "P2034" && attempt < SPEND_ATTEMPTS) continue;
      throw err;
    }
  }
}

/** Returns credit to the wallet when an order it paid for is cancelled. */
export async function refundToWallet(opts: {
  userId: string;
  orderId: string;
  amountPaise: number;
  description?: string;
}) {
  if (opts.amountPaise <= 0) return null;
  try {
    return await prisma.walletEntry.create({
      data: {
        userId: opts.userId,
        orderId: opts.orderId,
        amountPaise: opts.amountPaise,
        reason: "refund",
        description: opts.description ?? "Refunded to your wallet",
      },
    });
  } catch {
    throw new ApiError(409, "That refund was already credited");
  }
}
