// Network & system status for the developer console (the founder's ONDC + alerts
// panels). ONDC is simulated until registration, so network health reports the
// configured provider mode honestly rather than faking a live gateway. The
// alerts feed is real: it surfaces open ErrorLog fingerprints plus derived
// operational signals (delayed jobs, refunds pending) — no invented incidents.

import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { ordersWaitingOnSeller } from "../ondc/waiting.js";

// Per-domain ONDC network status. In simulation mode every domain we support is
// "simulated" (honest); when PROVIDER_MODE flips to "ondc" these become live
// pings. Food + ride are the domains we actually transact; the rest are listed
// as planned so the founder's 5-domain view is represented truthfully.
export function ondcNetwork() {
  const live = env.PROVIDER_MODE === "ondc";
  const status = live ? "online" : "simulated";
  const domains = [
    { domain: "food", supported: true },
    { domain: "ride", supported: true },
    { domain: "ecom", supported: false },
    { domain: "travel", supported: false },
    { domain: "hospitality", supported: false },
  ];
  return {
    mode: env.PROVIDER_MODE, // "simulation" | "ondc"
    gatewayPingMs: live ? null : null, // real ping only once live
    domains: domains.map((d) => ({
      domain: d.domain,
      status: d.supported ? status : "planned",
    })),
  };
}

export type SystemAlert = {
  severity: "critical" | "warning" | "info" | "resolved";
  source: string;
  message: string;
  at: Date;
};

// Real, derived alerts feed. Each line maps to actual state in the DB so the
// founder's alerts panel reflects the system, not a script.
export async function systemAlerts(): Promise<{ alerts: SystemAlert[]; counts: { critical: number; warning: number } }> {
  const alerts: SystemAlert[] = [];

  // Open server errors → warnings/criticals depending on recency + count.
  const openErrors = await prisma.errorLog.findMany({
    where: { resolved: false },
    orderBy: { lastSeen: "desc" },
    take: 10,
  });
  for (const e of openErrors) {
    alerts.push({
      severity: e.count >= 5 ? "critical" : "warning",
      source: e.route ?? "server",
      message: `${e.name}: ${e.message.slice(0, 100)} (×${e.count})`,
      at: e.lastSeen,
    });
  }

  // Refunds awaiting action → warning.
  const refundsPending = await prisma.payment.count({ where: { status: "refund_pending" } });
  if (refundsPending > 0) {
    alerts.push({
      severity: "warning",
      source: "payments",
      message: `${refundsPending} refund${refundsPending > 1 ? "s" : ""} pending review.`,
      at: new Date(),
    });
  }

  // Open high/urgent support tickets → warning.
  const urgentTickets = await prisma.supportTicket.count({
    where: { status: { in: ["open", "in_progress"] }, priority: { in: ["high", "urgent"] } },
  });
  if (urgentTickets > 0) {
    alerts.push({
      severity: "warning",
      source: "support",
      message: `${urgentTickets} high-priority ticket${urgentTickets > 1 ? "s" : ""} open.`,
      at: new Date(),
    });
  }

  // ONDC orders a seller has not answered. A paid one is critical: the
  // customer's money is held with no order placed.
  const waiting = await ordersWaitingOnSeller();
  const paidStuck = waiting.filter((w) => (w.status === "confirming" || w.status === "paid") && w.paidPaise != null);
  if (paidStuck.length > 0) {
    alerts.push({
      severity: "critical",
      source: "ondc",
      message: `${paidStuck.length} paid ONDC order${paidStuck.length > 1 ? "s are" : " is"} not placed with the seller after 10 minutes. Check with the seller, then place it again or refund.`,
      at: new Date(),
    });
  }
  const otherStuck = waiting.length - paidStuck.length;
  if (otherStuck > 0) {
    alerts.push({
      severity: "warning",
      source: "ondc",
      message: `${otherStuck} ONDC order${otherStuck > 1 ? "s are" : " is"} waiting on a seller that has not answered.`,
      at: new Date(),
    });
  }

  // Simulation-mode notice (informational, not an error).
  if (env.PROVIDER_MODE !== "ondc") {
    alerts.push({
      severity: "info",
      source: "ondc",
      message: "Fulfilment is in simulation mode. ONDC registration pending.",
      at: new Date(),
    });
  }

  alerts.sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2, resolved: 3 };
    return order[a.severity] - order[b.severity] || b.at.getTime() - a.at.getTime();
  });

  return {
    alerts,
    counts: {
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
    },
  };
}
