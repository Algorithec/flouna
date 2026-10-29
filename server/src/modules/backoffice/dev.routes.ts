// Developer console API — diagnostics and operational controls for engineers.
// Scoped to the `developer` role (and `super_admin`, who can see everything).
// Read-mostly: error log, system health, provider status, feature flags, and a
// slice of the audit trail. No customer PII beyond ids; no money actions here.

import { Router } from "express";
import { z } from "zod";
import os from "node:os";
import { prisma } from "../../lib/prisma.js";
import { requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { env } from "../../config/env.js";
import { llm } from "../chat/llm/index.js";
import { listFlags, setFlag } from "./flags.service.js";
import { auditFromReq } from "./audit.service.js";
import { ondcNetwork, systemAlerts } from "./systemStatus.service.js";
import { listTransactions, getTransaction } from "./ondc.service.js";

// Parsed, not coerced: see the note in admin.routes.ts. A negative `limit`
// reached Prisma as a negative take, which reads backwards from a cursor there
// is none of — so `?limit=-5` answered 200 with an empty audit trail.
const pageParam = z.coerce.number().int().min(1).max(100_000).catch(1);
const limitParam = z.coerce.number().int().min(1).max(200).catch(50);

export const devRouter = Router();

// Every route here requires developer or super_admin. requireRole re-checks the
// DB each call, so a revoked engineer loses access immediately.
devRouter.use(requireRole("developer", "super_admin"));

// --- System health & runtime metrics ---
devRouter.get("/health", async (_req, res, next) => {
  try {
    const started = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Date.now() - started;
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      db: "ok",
      dbLatencyMs,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      env: env.NODE_ENV,
      memory: {
        rssMb: Math.round(mem.rss / 1_048_576),
        heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
        heapTotalMb: Math.round(mem.heapTotal / 1_048_576),
      },
      loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ ok: false, db: "unreachable" });
  }
});

// --- Provider / integration status (no secrets, just configured-or-not) ---
devRouter.get("/providers", (_req, res) => {
  const configured = (v?: string) => Boolean(v && v.length > 0);
  res.json({
    llm: { active: llm.name, mode: env.LLM_PROVIDER },
    integrations: {
      anthropic: configured(env.ANTHROPIC_API_KEY),
      google_ai: configured(env.GOOGLE_AI_API_KEY),
      deepseek: configured(env.DEEPSEEK_API_KEY),
      smtp: configured(env.SMTP_HOST),
      google_oauth: configured(env.GOOGLE_CLIENT_ID),
      cashfree: configured(env.CASHFREE_APP_ID),
      google_maps: configured(env.GOOGLE_MAPS_API_KEY),
      geoapify: configured(env.GEOAPIFY_KEY),
      ors: configured(env.ORS_KEY),
      web_push: configured(env.VAPID_PUBLIC_KEY),
      sentry: configured(env.SENTRY_DSN),
    },
    fulfilment: { mode: env.PROVIDER_MODE }, // "simulation" until ONDC registration
  });
});

// --- Error log (the headline feature: failures land here automatically) ---
devRouter.get("/errors", async (req, res, next) => {
  try {
    const includeResolved = req.query.resolved === "true";
    const errors = await prisma.errorLog.findMany({
      where: includeResolved ? {} : { resolved: false },
      orderBy: { lastSeen: "desc" },
      take: 100,
    });
    const openCount = await prisma.errorLog.count({ where: { resolved: false } });
    res.json({ errors, openCount });
  } catch (err) {
    next(err);
  }
});

// Mark an error fingerprint resolved (engineer triage).
devRouter.patch(
  "/errors/:id/resolve",
  validateBody(z.object({ resolved: z.boolean().default(true) }).strict()),
  async (req, res, next) => {
    try {
      const { resolved } = req.body as { resolved: boolean };
      const updated = await prisma.errorLog
        .update({ where: { id: req.params.id! }, data: { resolved } })
        .catch(() => null);
      if (!updated) return res.status(404).json({ error: "Not found" });
      await auditFromReq(req, {
        action: resolved ? "error.resolve" : "error.reopen",
        targetType: "error",
        targetId: updated.id,
        summary: `${resolved ? "Resolved" : "Reopened"} ${updated.name}: ${updated.message.slice(0, 80)}`,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// --- Feature flags ---
devRouter.get("/flags", async (_req, res, next) => {
  try {
    res.json({ flags: await listFlags() });
  } catch (err) {
    next(err);
  }
});

devRouter.patch(
  "/flags/:key",
  validateBody(z.object({ enabled: z.boolean() }).strict()),
  async (req, res, next) => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      const key = req.params.key!;
      await setFlag(key, enabled, req.userId!);
      await auditFromReq(req, {
        action: "flag.set",
        targetType: "flag",
        targetId: key,
        summary: `Set flag "${key}" ${enabled ? "ON" : "OFF"}`,
        metadata: { enabled },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// --- ONDC network status (simulated until registration) ---
devRouter.get("/network", (_req, res) => {
  res.json(ondcNetwork());
});

// --- System alerts feed (real: derived from errors, refunds, tickets) ---
devRouter.get("/alerts", async (_req, res, next) => {
  try {
    res.json(await systemAlerts());
  } catch (err) {
    next(err);
  }
});

// --- ONDC transaction log (Beckn envelopes; simulated until registration) ---
devRouter.get("/transactions", async (req, res, next) => {
  try {
    const action = typeof req.query.action === "string" ? req.query.action : undefined;
    const page = pageParam.parse(req.query.page);
    res.json(await listTransactions({ action, page }));
  } catch (err) {
    next(err);
  }
});

devRouter.get("/transactions/:id", async (req, res, next) => {
  try {
    const txn = await getTransaction(req.params.id!);
    if (!txn) return res.status(404).json({ error: "Not found" });
    res.json({ transaction: txn });
  } catch (err) {
    next(err);
  }
});

// --- Audit trail (read-only slice; super-admin gets the full viewer too) ---
devRouter.get("/audit", async (req, res, next) => {
  try {
    const take = limitParam.parse(req.query.limit);
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take,
    });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});
