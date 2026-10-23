import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pruneDecisionLogs } from "./modules/advisor/decisionLog.service.js";
import { pruneIntentWatches } from "./modules/chat/llm/watcher.js";
import { prisma } from "./lib/prisma.js";
import { processDueDeletions } from "./modules/compliance/privacy.service.js";
import { initRealtime } from "./realtime/socket.js";
import { checkPriceAlerts } from "./modules/alerts/alerts.service.js";
import {
  startOutboxWorker,
  runLifecycleSweep,
} from "./modules/notifications/outbox.service.js";
import { sweepPlusMemberships } from "./modules/subscription/subscription.service.js";
import { initMonitoring, captureError } from "./lib/monitoring.js";
import { seedDemoCoupons } from "./data/coupons.js";
import { shouldSync, syncSchema } from "./lib/schemaSync.js";
import { pruneOndcSearches } from "./modules/ondc/search.service.js";
import { pruneNoLogs, pushPending } from "./modules/ondc/observability.js";
import { keepConnectionsAlive } from "./lib/keepAlive.js";

initMonitoring();

// Last-resort safety net. Every route handler already wraps its own work in
// try/catch and forwards to Express's error middleware — this is for
// whatever isn't, whether that's a handler someone adds later without one, a
// background job's stray promise, or a dependency's internal rejection. Node
// terminates the process on an unhandled rejection by default; without this,
// one missed catch anywhere takes every concurrent user down with it instead
// of failing the one request that hit it.
process.on("unhandledRejection", (reason) => {
  captureError(reason, { kind: "unhandledRejection" });
});
// An uncaught synchronous throw means something is in a state Node itself no
// longer trusts — continuing risks serving corrupted responses. Exit and let
// the platform's restart policy (Railway: ON_FAILURE) bring up a clean
// process, rather than either crashing silently or running on regardless.
process.on("uncaughtException", (err) => {
  captureError(err, { kind: "uncaughtException" });
  process.exit(1);
});

// Bring the database up to the schema BEFORE accepting a request. Starting
// first and migrating after would mean serving 500s to whoever arrives in
// between — which is exactly the outage this was written for.
//
// If it fails, the process exits rather than starting. That is the point: a
// deployment that cannot reach its own schema must not replace one that can,
// and the platform's healthcheck and restart policy will keep the previous
// release serving instead.
if (shouldSync()) {
  try {
    await syncSchema();
  } catch {
    console.error("[startup] refusing to start against a schema that could not be applied");
    process.exit(1);
  }
}

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`flouna-api listening on http://localhost:${env.PORT}`);
});
// Idle connections outlive the web proxy's pool, so a reused one is never
// closed under a request (see lib/keepAlive.ts).
keepConnectionsAlive(server);

// Realtime channel for live price-drop alerts.
initRealtime(server);

// Every minute, check active price alerts and notify owners on a match.
const alertLoop = setInterval(async () => {
  try {
    const n = await checkPriceAlerts();
    if (n > 0) console.log(`[alerts] triggered ${n} price alert(s)`);
  } catch (err) {
    console.error("[alerts] check failed:", err);
  }
}, 60_000);

// Demo promo codes, so checkout works out of the box in dev.
void seedDemoCoupons().catch((err) => console.error("[coupons] seed failed:", err));

// Drain the email-notification outbox every 30s.
const stopOutbox = startOutboxWorker();

// Daily sweep: Plus renewal reminders (~3 days out) and expiry emails. Runs
// once on boot (catches anything missed while down) then every 24h. Idempotent.
async function runPlusSweep() {
  try {
    const { reminded, expired } = await sweepPlusMemberships();
    if (reminded || expired)
      console.log(`[plus] reminded ${reminded}, expired ${expired}`);
  } catch (err) {
    console.error("[plus] sweep failed:", err);
  }
}
async function runLifecycle() {
  try {
    const { onboarding, winBack, plusValue } = await runLifecycleSweep();
    if (onboarding || winBack || plusValue)
      console.log(
        `[lifecycle] onboarding ${onboarding}, win-back ${winBack}, plus-value ${plusValue}`,
      );
  } catch (err) {
    console.error("[lifecycle] sweep failed:", err);
  }
}
void runPlusSweep();
void runLifecycle();
const plusSweep = setInterval(runPlusSweep, 24 * 60 * 60_000);
const lifecycleSweep = setInterval(runLifecycle, 24 * 60 * 60_000);

/** How long a ranking decision stays queryable before housekeeping drops it. */
const DECISION_LOG_RETENTION_DAYS = 90;

// ONDC Network Observability: push queued logs to ONDC every half minute.
// Only runs when a profile's token is set; each push is bounded, so a slow
// logging service never piles work up here.
const noLoop = setInterval(() => {
  if (!env.ONDC_NO_TOKEN_RETAIL && !env.ONDC_NO_TOKEN_RIDE) return;
  void pushPending().catch((err: unknown) => console.error("[ondc-no] push failed:", err instanceof Error ? err.message : String(err)));
}, 30_000);

// Hourly housekeeping: expired OTP codes and dead refresh tokens never pile up.
const cleanup = setInterval(
  async () => {
    try {
      const dayAgo = new Date(Date.now() - 86_400_000);
      await prisma.otpCode.deleteMany({
        where: { OR: [{ expiresAt: { lt: dayAgo } }, { consumedAt: { lt: dayAgo } }] },
      });
      await prisma.refreshToken.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: dayAgo } }],
        },
      });
      // Ranking decisions are kept long enough to answer "why was I shown
      // this?" and to satisfy an audit, then dropped — one row per search
      // would otherwise grow without bound.
      await pruneDecisionLogs(DECISION_LOG_RETENTION_DAYS);
      // The watcher's readings carry message text, so they go on the same clock.
      await pruneIntentWatches(DECISION_LOG_RETENTION_DAYS);
      // ONDC searches carry the customer's location and every seller's whole
      // catalogue; neither is needed once the results have been read.
      await pruneOndcSearches();
      await pruneNoLogs();
      // Erasures whose grace period has run out. A deletion that only happens
      // while somebody is watching a screen is not a deletion, and the promise
      // in the privacy policy is measured in days, not in attention.
      const erased = await processDueDeletions();
      if (erased > 0) console.log(`[cleanup] erased ${erased} account(s) on schedule`);
    } catch (err) {
      console.error("[cleanup] failed:", err);
    }
  },
  60 * 60_000,
);

// Graceful shutdown: finish in-flight requests, close DB, then exit.
async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal} received`);
  clearInterval(cleanup);
  clearInterval(noLoop);
  clearInterval(alertLoop);
  clearInterval(plusSweep);
  clearInterval(lifecycleSweep);
  stopOutbox();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Hard exit if connections refuse to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
