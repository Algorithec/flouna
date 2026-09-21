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

  void prisma.decisionLog
    .create({
      data: {
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
      },
    })
    .catch(() => {
      // Best-effort by design; never block or fail a user's request.
    });

  return id;
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
}): void {
  void prisma.decisionLog
    .update({
      where: { id: input.decisionId },
      data: {
        selectedKey: input.selectedKey,
        selectedAt: new Date(),
        orderId: input.orderId,
      },
    })
    .catch(() => {
      // Best-effort, exactly like the write above.
    });
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
