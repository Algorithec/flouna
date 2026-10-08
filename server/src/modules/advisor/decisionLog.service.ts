import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import type { DecisionTrace } from "./scoring.js";

// Records how a recommendation was reached, so a past ranking can be
// reconstructed and explained.
//
// ONDC's buyer-app disclosure asks a buyer app to account for its listing and
// ranking behaviour. Price observations record what an option cost; only this
// records why one option was placed above another — which filters removed what,
// which weights were applied, and what every surviving option scored.
//
// Writes are fire-and-forget, exactly like price observations: a logging fault
// must never surface as a failed search.

/** Keep the stored ordering useful without letting one row grow unbounded. */
const MAX_SCORED_ROWS = 20;

/**
 * Records a ranking and hands back its id.
 *
 * The id is minted here rather than by the database so this can stay
 * fire-and-forget while still telling the caller what to quote back when the
 * customer acts on the recommendation. Awaiting the insert to read a generated
 * id would put a logging write on the critical path of every search, which is
 * the one thing this module promises not to do.
 *
 * randomUUID rather than a cuid: the only cuid generator in the tree arrives
 * through Prisma, and a transitive dependency is not something to build an id
 * scheme on. The column is a plain string and never parsed.
 */
export function recordDecision(input: {
  userId?: string | null;
  domain: "food" | "ride";
  /** The user's search text, or a route summary for rides. */
  query: string;
  trace: DecisionTrace;
}): string {
  const { trace } = input;
  const id = randomUUID();

  // Still fire-and-forget: logging must never slow or fail a search. But it
  // used to make one attempt and swallow any error, so a moment of contention
  // (SQLite reports it as locked, Postgres as a pool timeout or a dropped
  // connection) silently deleted the decision. The audit trail got a hole,
  // and the order that later quoted this id retried for half a minute against
  // a row that would never exist. With the database refusing writes for six
  // seconds, 0 of 10 decisions were recorded. Transient refusals are now
  // waited out on the same schedule pairing uses.
  const data = {
    id,
    userId: input.userId ?? null,
    domain: input.domain,
    query: input.query.slice(0, 500),
    priority: trace.priority,
    weights: JSON.stringify(trace.weights),
    personalized: trace.personalized,
    candidateCount: trace.candidateCount,
    excludedCount: trace.excludedCount,
    exclusions: trace.exclusions.length ? JSON.stringify(trace.exclusions) : null,
    // Best-first, truncated: the top of the ordering is what explains the
    // decision, and a pathological result set shouldn't bloat a row.
    results: JSON.stringify(trace.scores.slice(0, MAX_SCORED_ROWS)),
    chosenKey: trace.chosenKey,
  };
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await prisma.decisionLog.create({ data });
        return;
      } catch (err) {
        // The id is ours and unique, so finding it taken means an earlier
        // attempt did land and only its reply was lost.
        if ((err as { code?: string }).code === "P2002") return;
        const delay = PAIRING_RETRY_DELAYS_MS[attempt];
        if (isTransient(err) && delay !== undefined) {
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        const code = (err as { code?: string }).code ?? "no code";
        const text = err instanceof Error ? err.message : String(err);
        console.warn(
          `[decision] could not record decision ${id} (${code}): ${text.replace(/\s+/g, " ").trim()}`,
        );
        return;
      }
    }
  })();

  return id;
}

/**
 * How long to keep trying to pair a decision with its order.
 *
 * recordDecision does not wait for its own insert, so a customer who orders
 * immediately can have the update reach the database first. The update then
 * fails with "record not found", and because both writes are deliberately
 * silent, the pairing disappears without a trace: the one piece of data this
 * module exists to collect, lost precisely on the fastest, most decisive
 * orders. Verified by racing the two writes directly.
 *
 * The window was first 800 ms, on the assumption that an insert lands well
 * inside that. Under contention it does not: 25 inserts took 2.7 s and then
 * 7.1 s. A write's latency has no bound, so the window is not tuned to it but
 * made to outlast realistic slowness, doubling from 25 ms to a 5 s ceiling for
 * about half a minute in all. That costs a customer nothing, because none of
 * this is on the request path.
 */
const PAIRING_RETRY_DELAYS_MS = [
  25, 50, 100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000, 5000,
];

/**
 * How a pairing attempt ended.
 *
 * Returned rather than the function staying void, so a caller that needs to
 * know, a test above all, can await it. The order route still does not wait:
 * the order must never be held up by its own logging.
 */
export type PairingOutcome = "paired" | "not_owned" | "gave_up";

/**
 * Prisma codes for faults that pass on their own.
 *
 * P2025 is the one this retry was written for: the decision's insert has not
 * landed yet. The rest are the database being slow or briefly unreachable, a
 * connection pool exhausted, a write conflict: all resolve if you wait.
 */
const TRANSIENT_CODES = new Set(["P2025", "P1001", "P1002", "P1008", "P1017", "P2024", "P2034"]);

/**
 * Whether waiting and trying again could succeed.
 *
 * The first version retried only P2025. Under load the update also fails with
 * a socket timeout while it waits for a lock, which carries no code at all, so
 * it was treated as permanent and the pairing abandoned on the first attempt
 * however long the retry window was. With the row present and no insert
 * failing, 3 or 4 of 25 pairings were still lost that way, and a longer window
 * changed nothing, because that path never reached it.
 *
 * A validation error means the data itself is wrong, and no amount of waiting
 * fixes that, so it is the one kind never retried, whatever its message says.
 */
export function isTransient(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string };
  if (e?.name === "PrismaClientValidationError") return false;
  if (e?.code && TRANSIENT_CODES.has(e.code)) return true;
  return /timeout|timed out|database is locked|busy|connection/i.test(e?.message ?? "");
}

/**
 * Closes the loop: what the customer actually chose, and what it became.
 *
 * Derived server-side from the order being placed rather than sent by the
 * client, so the training signal cannot be shaped by whoever is calling the
 * API. Silent when the id does not match a row: a decision may have been
 * pruned, or the client may be quoting an id from a previous session, and
 * neither is a reason to fail an order that is otherwise good.
 */
export function recordSelection(input: {
  decisionId: string;
  /** In the same key space as the trace: "dishId@platform", or a ride's product name. */
  selectedKey: string;
  orderId: string;
  /**
   * The customer placing the order. A decision is paired only with an order
   * from the customer it was made for.
   *
   * Without this, any valid decision id could be quoted on an unrelated order,
   * by mistake or on purpose, and its choice would be recorded as that
   * customer's. This record is training data, so a wrong pairing is not a
   * harmless log line: it teaches the ranker something nobody chose.
   */
  userId: string;
}): Promise<PairingOutcome> {
  return (async (): Promise<PairingOutcome> => {
    // Prisma drops a filter whose value is undefined, so without this a
    // missing user would match on the id alone: the exact hole the user check
    // exists to close.
    if (!input.userId) return "not_owned";
    for (let attempt = 0; ; attempt++) {
      try {
        const { count } = await prisma.decisionLog.updateMany({
          where: { id: input.decisionId, userId: input.userId },
          data: {
            selectedKey: input.selectedKey,
            selectedAt: new Date(),
            orderId: input.orderId,
          },
        });
        if (count === 1) return "paired";

        // Nothing matched. Either the decision's insert has not landed yet,
        // which is worth waiting for, or the row is there and belongs to
        // someone else, which no amount of waiting fixes. One read tells them
        // apart, and only on this path.
        const exists = await prisma.decisionLog.findUnique({
          where: { id: input.decisionId },
          select: { userId: true },
        });
        // The row can also be this customer's own, written between the update
        // that missed it and this read. That is not a refusal: it goes round
        // the same bounded backoff as a row not written yet, and the update
        // will now find it. Only a row that belongs to someone else is refused.
        if (exists && exists.userId !== input.userId) {
          console.warn(
            `[decision] refused to pair decision ${input.decisionId} with order ${input.orderId}: it belongs to a different customer`,
          );
          return "not_owned";
        }
        throw Object.assign(new Error("decision not written yet"), { code: "P2025" });
      } catch (err) {
        const delay = PAIRING_RETRY_DELAYS_MS[attempt];
        if (isTransient(err) && delay !== undefined) {
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // Out of retries, or a fault that retrying cannot help. Say so rather
        // than swallowing it: a decision log quietly missing its outcomes
        // looks exactly like customers who never ordered, and that is a
        // conclusion nobody should reach by accident.
        //
        // The code is logged, and the message flattened to one line. Prisma
        // messages open with a blank line, so the old log showed nothing after
        // the colon, and that blank is what hid which error was really
        // abandoning these pairings.
        const code = (err as { code?: string }).code ?? "no code";
        const text = err instanceof Error ? err.message : String(err);
        console.warn(
          `[decision] could not pair decision ${input.decisionId} with order ${input.orderId} (${code}): ${text.replace(/\s+/g, " ").trim()}`,
        );
        return "gave_up";
      }
    }
  })();
}

/**
 * Delete entries older than the retention window. Called by the maintenance
 * job. Returns the number removed so the caller can log it.
 */
export async function pruneDecisionLogs(
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.decisionLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}
