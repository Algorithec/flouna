import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { llm, watcherProvider } from "../chat/llm/index.js";
import { CALLBACK_ACTIONS } from "../ondc/callbacks.routes.js";
import { commercialTerms } from "../ondc/commercial.js";

// What the developer console shows about the two things that run on their
// own: the model reading chat messages, and the ONDC network connection.
//
// Everything here is read from what is already recorded (the provider on each
// assistant message, the watcher's comparisons, the ONDC transaction log and
// the observability queue). Nothing is a secret: a key or token is reported
// only as set or not set, and an error message is cleaned of the tokens before
// it leaves the server.

const DAY_MS = 86_400_000;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

/** The model: which provider answers, how often it falls back, and how the watcher compares. */
export async function modelOps(now = new Date()) {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const assistant = { role: "assistant", createdAt: { gte: since } };
  const [byProvider, fellBack, allFailed, watches] = await Promise.all([
    prisma.chatMessage.groupBy({ by: ["provider"], where: assistant, _count: { _all: true } }),
    // depth > 0: a provider further down the chain answered after the first failed.
    prisma.chatMessage.count({ where: { ...assistant, providerDepth: { gt: 0 } } }),
    // depth -1: every provider failed and the rule engine answered.
    prisma.chatMessage.count({ where: { ...assistant, providerDepth: -1 } }),
    prisma.intentWatch.findMany({
      where: { createdAt: { gte: since } },
      select: { watcher: true, agreed: true, fields: true, latencyMs: true, error: true },
      orderBy: { createdAt: "desc" },
      take: 5000,
    }),
  ]);

  const answered = byProvider.reduce((n, r) => n + r._count._all, 0);
  const fieldTally = new Map<string, { agreed: number; compared: number }>();
  const latencies: number[] = [];
  let agreed = 0;
  let failed = 0;
  for (const w of watches) {
    if (w.error) {
      failed++;
      continue;
    }
    latencies.push(w.latencyMs);
    if (w.agreed) agreed++;
    let fields: Record<string, unknown> = {};
    try {
      fields = JSON.parse(w.fields) as Record<string, unknown>;
    } catch {
      // A row that cannot be read is not counted against any field.
    }
    for (const [name, ok] of Object.entries(fields)) {
      const t = fieldTally.get(name) ?? { agreed: 0, compared: 0 };
      t.compared++;
      if (ok === true) t.agreed++;
      fieldTally.set(name, t);
    }
  }
  latencies.sort((a, b) => a - b);
  const compared = watches.length - failed;

  return {
    windowDays: 7,
    config: {
      chain: llm.name,
      mode: env.LLM_PROVIDER,
      hybridRouting: env.HYBRID_ROUTING,
      watcher: watcherProvider?.name ?? null,
      selfHosted: { configured: Boolean(env.SELF_HOSTED_LLM_URL), model: env.SELF_HOSTED_LLM_MODEL },
    },
    traffic: {
      answered,
      byProvider: byProvider
        .map((r) => ({ provider: r.provider ?? "unlabelled", count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      fellBack,
      allFailed,
    },
    watcher: {
      readings: watches.length,
      failed,
      agreed,
      agreementPct: compared > 0 ? Math.round((agreed / compared) * 1000) / 10 : null,
      latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
      fields: [...fieldTally.entries()]
        .map(([field, t]) => ({ field, compared: t.compared, agreementPct: Math.round((t.agreed / t.compared) * 1000) / 10 }))
        .sort((a, b) => a.agreementPct - b.agreementPct || a.field.localeCompare(b.field)),
    },
  };
}

/** An observability error as stored, without the tokens, and short. */
function cleanError(message: string | null): string | null {
  if (!message) return null;
  let out = message;
  for (const token of [env.ONDC_NO_TOKEN_RETAIL, env.ONDC_NO_TOKEN_RIDE]) {
    if (token) out = out.split(token).join("[token]");
  }
  return out.slice(0, 200);
}

/** The ONDC connection: configuration, callback traffic, the log queue, and where orders stand. */
export async function ondcOps(now = new Date()) {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

  let terms: ReturnType<typeof commercialTerms> | null = null;
  let termsProblem: string | null = null;
  try {
    terms = commercialTerms();
  } catch (err) {
    termsProblem = err instanceof Error ? err.message : String(err);
  }

  const [traffic, simulated, lastDay, pending, failing, sentToday, lastFailure, orders, rides, settlements] =
    await Promise.all([
      prisma.ondcTransaction.groupBy({
        by: ["action", "status"],
        where: { createdAt: { gte: weekAgo }, simulated: false },
        _count: { _all: true },
      }),
      prisma.ondcTransaction.count({ where: { createdAt: { gte: weekAgo }, simulated: true } }),
      prisma.ondcTransaction.count({ where: { createdAt: { gte: dayAgo }, simulated: false } }),
      prisma.ondcNoLog.count({ where: { sentAt: null } }),
      prisma.ondcNoLog.count({ where: { sentAt: null, attempts: { gt: 0 } } }),
      prisma.ondcNoLog.count({ where: { sentAt: { gte: dayAgo } } }),
      prisma.ondcNoLog.findFirst({
        where: { sentAt: null, lastError: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { domain: true, type: true, attempts: true, lastError: true, createdAt: true },
      }),
      prisma.ondcOrder.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.ondcRide.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.ondcSettlement.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

  const actions = new Map<string, { action: string; ack: number; nack: number; error: number }>();
  for (const r of traffic) {
    const row = actions.get(r.action) ?? { action: r.action, ack: 0, nack: 0, error: 0 };
    if (r.status === "ack" || r.status === "nack" || r.status === "error") row[r.status] += r._count._all;
    actions.set(r.action, row);
  }
  const counts = (rows: { status: string; _count: { _all: number } }[]) =>
    rows.map((r) => ({ status: r.status, count: r._count._all })).sort((a, b) => b.count - a.count);

  return {
    windowDays: 7,
    config: {
      providerMode: env.PROVIDER_MODE,
      registry: env.ONDC_REGISTRY_ENV,
      subscriberId: env.ONDC_SUBSCRIBER_ID ?? null,
      callbackActions: CALLBACK_ACTIONS.length,
      keys: {
        uniqueKeyId: Boolean(env.ONDC_UNIQUE_KEY_ID),
        signing: Boolean(env.ONDC_SIGNING_PRIVATE_KEY),
        encryption: Boolean(env.ONDC_ENCRYPTION_PRIVATE_KEY),
      },
      observabilityTokens: { retail: Boolean(env.ONDC_NO_TOKEN_RETAIL), ride: Boolean(env.ONDC_NO_TOKEN_RIDE) },
      searchEnabled: env.ONDC_SEARCH_ENABLED,
      staticTerms: terms?.staticTerms ?? null,
      finderFeePercent: terms?.finderFeePercent ?? null,
      foodCollectedBy: terms?.foodCollectedBy ?? null,
      settlementAccount: Boolean(terms?.settlement),
      gstin: Boolean(terms?.gstin),
      // The founder decisions still open, in the words the server logs them.
      unconfirmed: termsProblem ? [termsProblem] : (terms?.unconfirmed ?? []),
    },
    callbacks: {
      lastDay,
      simulated,
      byAction: [...actions.values()].sort((a, b) => a.action.localeCompare(b.action)),
    },
    observability: {
      pending,
      failing,
      sentToday,
      lastFailure: lastFailure
        ? { ...lastFailure, lastError: cleanError(lastFailure.lastError) }
        : null,
    },
    orders: counts(orders),
    rides: counts(rides),
    settlements: counts(settlements),
  };
}
