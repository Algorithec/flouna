import { Prisma } from "@prisma/client";

// Running a transaction again when the database gave up on it.
//
// The money paths (spending reward credit, claiming a capped code, taking a
// seat on a shared ride) run as serializable transactions so two requests
// cannot both win. Under contention the database refuses one of them, and it
// does so in more than one way: a serialization failure (P2034), a socket
// timeout while waiting on the lock (P1008), or a transaction that expired
// before it could finish (P2028). Each is a transaction that committed
// nothing, so it is safe to run again. Only the first used to be retried, and
// the other two reached the customer as a server error.

const RETRYABLE_CODES = new Set(["P2034", "P1008", "P2028"]);
const RETRYABLE_MESSAGE =
  /database is locked|SQLITE_BUSY|could not serialize|socket timeout|transaction not found|transaction already closed/i;

/** A transaction the database refused only because of contention. */
export function isRetryableTxError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE_CODES.has(err.code)) return true;
    if (err.code === "P2002") return false;
  }
  const e = err as { code?: string; message?: string; status?: number };
  if (typeof e?.status === "number") return false; // a refusal meant for the customer
  if (e?.code && RETRYABLE_CODES.has(e.code)) return true;
  return err instanceof Error && RETRYABLE_MESSAGE.test(err.message);
}

/**
 * Runs `attempt` until it succeeds, stops failing for contention, or runs out
 * of tries. Waits a short, growing and randomised time between tries:
 * retrying at once put every loser straight back against the same lock.
 */
export async function withTxRetry<T>(
  attempt: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const baseMs = opts.baseMs ?? 20;
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (n >= attempts || !isRetryableTxError(err)) throw err;
      const wait = baseMs * 2 ** (n - 1);
      await new Promise((r) => setTimeout(r, wait / 2 + Math.random() * wait));
    }
  }
}

/**
 * Transaction limits for the contended paths: long enough to wait out a busy
 * moment rather than expire in the middle of it.
 */
export const CONTENDED_TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 10_000,
  timeout: 15_000,
} as const;
