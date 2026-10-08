import { prisma } from "../../../lib/prisma.js";
import { env } from "../../../config/env.js";
import type { Intent, LlmProvider } from "./types.js";
import { watcherProvider } from "./index.js";

// The watcher: a second model reading every chat message beside the one that
// answers, so a model can be measured on real traffic before it is trusted
// with customers.
//
// It never changes a reply. It runs after the answer's reading is settled, is
// not awaited by the request, and anything it does wrong (a timeout, an error,
// nonsense) is recorded and goes no further. What it records is whether the
// two readings agree, field by field, because "agreed on the domain but lost
// the budget" and "agreed on everything" lead to very different decisions.

/**
 * The fields compared. These are the ones the engine acts on: a stated price
 * or time limit that a model drops is a limit the customer loses, so each is
 * judged on its own rather than folded into one score.
 */
const FIELDS: Array<[string, (i: Intent) => unknown]> = [
  ["domain", (i) => i.domain],
  ["food.item", (i) => norm(i.food?.item)],
  ["food.budgetPaise", (i) => i.food?.budgetPaise ?? null],
  ["food.maxEtaMinutes", (i) => i.food?.maxEtaMinutes ?? null],
  ["food.dietary", (i) => i.food?.dietary],
  ["food.priority", (i) => i.food?.priority],
  ["ride.drop", (i) => norm(i.ride?.drop)],
  ["ride.vehicle", (i) => i.ride?.vehicle],
  ["ride.budgetPaise", (i) => i.ride?.budgetPaise ?? null],
  ["ride.maxPickupMinutes", (i) => i.ride?.maxPickupMinutes ?? null],
  ["ride.scheduleAt", (i) => i.ride?.scheduleAt ?? null],
  ["ride.priority", (i) => i.ride?.priority],
  ["shop.item", (i) => norm(i.shop?.item)],
  ["shop.budgetPaise", (i) => i.shop?.budgetPaise ?? null],
  ["shop.category", (i) => i.shop?.category],
];

/** Case and spacing are not disagreements: "Biryani " and "biryani" match. */
function norm(s: string | undefined): string | undefined {
  return s === undefined ? undefined : s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Field by field agreement between two readings of one message.
 *
 * Only fields that apply are compared: a food field counts when either reading
 * has a food part, so a watcher that misses the food half of a combo is marked
 * wrong on it, while a ride request is not marked on food fields neither has.
 */
export function compareIntents(
  primary: Intent,
  watched: Intent,
): { agreed: boolean; fields: Record<string, boolean> } {
  const fields: Record<string, boolean> = {};
  for (const [name, read] of FIELDS) {
    const part = name.split(".")[0] as "food" | "ride" | "shop" | "domain";
    if (part !== "domain" && !primary[part] && !watched[part]) continue;
    fields[name] = JSON.stringify(read(primary)) === JSON.stringify(read(watched));
  }
  return { agreed: Object.values(fields).every(Boolean), fields };
}

/**
 * Reads the message with the watcher and records how it compares. Returns the
 * stored row's promise for tests; callers must not await it on a request path.
 */
export function watchIntent(
  message: string,
  primary: Intent,
  primaryProvider: string,
  opts: { provider?: LlmProvider | null; sample?: number; random?: () => number } = {},
): Promise<void> | null {
  const provider = opts.provider === undefined ? watcherProvider : opts.provider;
  if (!provider) return null;
  const sample = opts.sample ?? env.LLM_WATCHER_SAMPLE;
  if ((opts.random ?? Math.random)() >= sample) return null;

  return (async () => {
    const started = Date.now();
    let watched: Intent | null = null;
    let error: string | null = null;
    try {
      watched = await provider.extractIntent(message);
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300);
    }
    const latencyMs = Date.now() - started;
    const compared = watched ? compareIntents(primary, watched) : { agreed: false, fields: {} };
    try {
      await prisma.intentWatch.create({
        data: {
          watcher: provider.name,
          primaryProvider,
          message: message.slice(0, 500),
          agreed: compared.agreed,
          fields: JSON.stringify(compared.fields),
          primaryIntent: JSON.stringify(primary),
          watcherIntent: watched ? JSON.stringify(watched) : null,
          latencyMs,
          error,
        },
      });
    } catch (err) {
      // Measurement is never worth an error a customer could see.
      console.warn(`[watcher] could not record a reading: ${err instanceof Error ? err.message : err}`);
    }
  })();
}

/** How the watcher has done over recent days, overall and field by field. */
export async function watcherSummary(days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.intentWatch.findMany({
    where: { createdAt: { gte: since } },
    select: { watcher: true, agreed: true, fields: true, latencyMs: true, error: true },
  });
  const answered = rows.filter((r) => !r.error);
  const byField: Record<string, { compared: number; agreed: number; rate: number }> = {};
  for (const r of answered) {
    for (const [field, ok] of Object.entries(JSON.parse(r.fields) as Record<string, boolean>)) {
      const f = (byField[field] ??= { compared: 0, agreed: 0, rate: 0 });
      f.compared += 1;
      if (ok) f.agreed += 1;
    }
  }
  for (const f of Object.values(byField)) f.rate = f.compared ? f.agreed / f.compared : 0;
  const latencies = answered.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]! : null;
  return {
    days,
    watchers: [...new Set(rows.map((r) => r.watcher))],
    readings: rows.length,
    errors: rows.length - answered.length,
    agreedRate: answered.length ? answered.filter((r) => r.agreed).length / answered.length : null,
    byField,
    latencyMs: { p50: pct(0.5), p95: pct(0.95) },
  };
}

/** Drops readings older than the retention window; returns how many. */
export async function pruneIntentWatches(retentionDays: number): Promise<number> {
  const { count } = await prisma.intentWatch.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - retentionDays * 86_400_000) } },
  });
  return count;
}
