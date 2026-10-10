// Super-admin service — the only place operator roles are granted or revoked,
// plus revenue dashboards, config visibility and the full audit viewer.
//
// Role changes are the highest-stakes action in the system, so the guards here
// are deliberate:
//   - Only a super_admin reaches this module (enforced by the route).
//   - You cannot lock everyone out: the LAST active super_admin can't be demoted
//     or suspended, so there's always at least one operator who can recover.
//   - You cannot demote or suspend YOURSELF — prevents an accidental self-lockout
//     and forces a second super_admin to make that change deliberately.

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { CONTENDED_TX, withTxRetry } from "../../lib/txRetry.js";
import { env, isProd } from "../../config/env.js";
import { enqueueNotification } from "../notifications/outbox.service.js";
import { ROLES, type Role } from "../../lib/rbac.js";
import {
  cashfreeConfigured,
  createCashfreeRefund,
} from "../payments/cashfree.js";

// --- Staff / operators ---------------------------------------------------

export async function listOperators() {
  const operators = await prisma.user.findMany({
    where: { role: { not: "user" } },
    orderBy: [{ role: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      suspendedAt: true,
      createdAt: true,
    },
  });
  return operators.map((o) => ({
    id: o.id,
    name: o.name,
    email: o.email,
    role: o.role,
    suspended: Boolean(o.suspendedAt),
    createdAt: o.createdAt,
  }));
}

type RoleResult =
  | { ok: true; previous: Role; next: Role }
  | { ok: false; reason: "not_found" | "self" | "last_super_admin" | "invalid_role" };

async function activeSuperAdminCount(
  excludeId?: string,
  tx: Pick<typeof prisma, "user"> = prisma,
): Promise<number> {
  return tx.user.count({
    where: {
      role: "super_admin",
      suspendedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

/**
 * Counting the remaining super-admins and then writing are two steps, and the
 * whole point of the guard is that the pair cannot interleave. With two active
 * super-admins, two demotions sent at the same moment each counted "one other
 * still active" and each went through — leaving nobody who can grant a role,
 * which is the one state this module exists to make unreachable, and which no
 * amount of console access can repair.
 *
 * Serializable, so the database refuses one of the two, and the refusal is
 * retried and then sees the committed change. Same shape as the money paths.
 */
function lockoutSafe<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withTxRetry(() => prisma.$transaction(work, CONTENDED_TX));
}

// Grant or change an operator role. `actorId` is the super_admin making the
// change; we use it to block self-demotion.
export async function setOperatorRole(
  actorId: string,
  targetId: string,
  nextRole: string,
): Promise<RoleResult> {
  if (!(ROLES as readonly string[]).includes(nextRole)) {
    return { ok: false, reason: "invalid_role" };
  }
  const role = nextRole as Role;

  return lockoutSafe(async (tx): Promise<RoleResult> => {
    const target = await tx.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, suspendedAt: true },
    });
    if (!target) return { ok: false, reason: "not_found" };

    // Don't let a super_admin change their own role (prevents self-lockout; a
    // second super_admin must do it deliberately).
    if (targetId === actorId && role !== "super_admin") {
      return { ok: false, reason: "self" };
    }

    // Demoting the target away from super_admin: ensure another active one remains.
    if (target.role === "super_admin" && role !== "super_admin") {
      const others = await activeSuperAdminCount(targetId, tx);
      if (others === 0) return { ok: false, reason: "last_super_admin" };
    }

    await tx.user.update({ where: { id: targetId }, data: { role } });
    return { ok: true, previous: target.role as Role, next: role };
  });
}

type SuspendResult =
  | { ok: true; suspended: boolean }
  | { ok: false; reason: "not_found" | "self" | "last_super_admin" | "not_operator" };

// Suspend or reinstate an OPERATOR account (ordinary-user suspension lives in the
// admin module). Same last-super-admin and self guards apply.
export async function setOperatorSuspended(
  actorId: string,
  targetId: string,
  suspended: boolean,
): Promise<SuspendResult> {
  return lockoutSafe(async (tx): Promise<SuspendResult> => {
    const target = await tx.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true },
    });
    if (!target) return { ok: false, reason: "not_found" };
    if (target.role === "user") return { ok: false, reason: "not_operator" };
    if (targetId === actorId && suspended) return { ok: false, reason: "self" };

    if (suspended && target.role === "super_admin") {
      const others = await activeSuperAdminCount(targetId, tx);
      if (others === 0) return { ok: false, reason: "last_super_admin" };
    }

    await tx.user.update({
      where: { id: targetId },
      data: { suspendedAt: suspended ? new Date() : null },
    });
    return { ok: true, suspended };
  });
}

// --- Revenue / subscriptions --------------------------------------------

export async function revenueDashboard() {
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const paid = { status: { in: ["confirmed", "in_progress", "completed"] } };

  const [
    grossAgg,
    gross30Agg,
    byDomain,
    plusActive,
    refundsPending,
    refundedAgg,
  ] = await Promise.all([
    prisma.order.aggregate({ where: paid, _sum: { amount: true } }),
    prisma.order.aggregate({
      where: { ...paid, createdAt: { gte: since30 } },
      _sum: { amount: true },
    }),
    prisma.order.groupBy({
      by: ["domain"],
      where: paid,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.user.count({ where: { plusActive: true } }),
    prisma.payment.count({ where: { status: "refund_pending" } }),
    prisma.payment.aggregate({
      where: { status: "refunded" },
      _sum: { amount: true },
    }),
  ]);

  // Flouna Plus is ₹50/mo — model recurring run-rate from active subscribers.
  const planPaise = env.SUBSCRIPTION_PRICE_PAISE;

  return {
    grossPaise: grossAgg._sum.amount ?? 0,
    gross30dPaise: gross30Agg._sum.amount ?? 0,
    byDomain: Object.fromEntries(
      byDomain.map((d) => [
        d.domain,
        { grossPaise: d._sum.amount ?? 0, orders: d._count._all },
      ]),
    ),
    subscriptions: {
      activePlus: plusActive,
      monthlyRunRatePaise: plusActive * planPaise,
      planPaise,
    },
    refunds: {
      pending: refundsPending,
      refundedPaise: refundedAgg._sum.amount ?? 0,
    },
  };
}

// --- Config status (no secret values, only configured-or-not) ------------

export function configStatus() {
  const set = (v?: string) => Boolean(v && v.length > 0);
  return {
    runtime: {
      nodeEnv: env.NODE_ENV,
      providerMode: env.PROVIDER_MODE, // simulation | ondc
      llmProvider: env.LLM_PROVIDER,
    },
    secrets: {
      database: set(env.DATABASE_URL),
      jwtAccess: set(env.JWT_ACCESS_SECRET),
      jwtRefresh: set(env.JWT_REFRESH_SECRET),
      anthropic: set(env.ANTHROPIC_API_KEY),
      googleAi: set(env.GOOGLE_AI_API_KEY),
      smtp: set(env.SMTP_HOST),
      cashfree: set(env.CASHFREE_APP_ID) && set(env.CASHFREE_SECRET_KEY),
      googleOauth: set(env.GOOGLE_CLIENT_ID) && set(env.GOOGLE_CLIENT_SECRET),
      webPush: set(env.VAPID_PUBLIC_KEY) && set(env.VAPID_PRIVATE_KEY),
      sentry: set(env.SENTRY_DSN),
      ondc: set(env.ONDC_SUBSCRIBER_ID) && set(env.ONDC_SIGNING_PRIVATE_KEY),
    },
  };
}

// --- Growth analytics -----------------------------------------------------
// Daily series for the founder's growth view. Derived entirely from real rows
// (orders + users); bucketed in JS, which is fine at current volume — swap to a
// SQL date-trunc groupBy when order counts warrant it.

const PAID = ["confirmed", "in_progress", "completed"] as const;
const DAY_MS = 86_400_000;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC buckets)
}

export async function growthSeries(days = 30) {
  const since = new Date(Date.now() - (days - 1) * DAY_MS);
  since.setUTCHours(0, 0, 0, 0);

  const [orders, users] = await Promise.all([
    prisma.order.findMany({
      where: { createdAt: { gte: since }, status: { in: [...PAID] } },
      select: { createdAt: true, amount: true, userId: true },
    }),
    prisma.user.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
    }),
  ]);

  // Seed every day so the chart has a continuous axis even with no volume.
  const series = new Map<
    string,
    { date: string; orders: number; gmvPaise: number; signups: number }
  >();
  for (let i = 0; i < days; i++) {
    const key = dayKey(new Date(since.getTime() + i * DAY_MS));
    series.set(key, { date: key, orders: 0, gmvPaise: 0, signups: 0 });
  }
  for (const o of orders) {
    const row = series.get(dayKey(o.createdAt));
    if (row) {
      row.orders += 1;
      row.gmvPaise += o.amount;
    }
  }
  for (const u of users) {
    const row = series.get(dayKey(u.createdAt));
    if (row) row.signups += 1;
  }

  // Week-over-week movement + active buyers, from the same real rows.
  const wkAgo = Date.now() - 7 * DAY_MS;
  const twoWkAgo = Date.now() - 14 * DAY_MS;
  const thisWeek = orders.filter((o) => o.createdAt.getTime() >= wkAgo);
  const lastWeek = orders.filter(
    (o) => o.createdAt.getTime() >= twoWkAgo && o.createdAt.getTime() < wkAgo,
  );
  const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

  return {
    days,
    series: [...series.values()],
    totals: {
      orders: orders.length,
      gmvPaise: sum(orders),
      signups: users.length,
      activeBuyers7d: new Set(thisWeek.map((o) => o.userId)).size,
    },
    weekOverWeek: {
      ordersThisWeek: thisWeek.length,
      ordersLastWeek: lastWeek.length,
      gmvThisWeekPaise: sum(thisWeek),
      gmvLastWeekPaise: sum(lastWeek),
    },
  };
}

// --- Refund approval queue --------------------------------------------------
// Admins flag a paid order as refund_pending (admin console); only a super-admin
// settles it here. Approve marks the payment refunded; reject restores success.
// No gateway money moves yet — when Cashfree goes live, the refund API call
// slots into approveRefund before the status flip.

export async function listRefundQueue() {
  const payments = await prisma.payment.findMany({
    where: { status: "refund_pending" },
    orderBy: { updatedAt: "asc" }, // oldest waiting first
    include: {
      order: { select: { id: true, title: true, domain: true, createdAt: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });
  return payments.map((p) => ({
    paymentId: p.id,
    orderId: p.orderId,
    orderTitle: p.order.title,
    domain: p.order.domain,
    amountPaise: p.amount,
    method: p.method,
    user: p.user,
    flaggedAt: p.updatedAt,
  }));
}

type RefundResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_pending" }
  | { ok: false; reason: "gateway_failed"; message: string };

async function settleRefund(
  paymentId: string,
  nextStatus: "refunded" | "success",
): Promise<RefundResult> {
  // Status-scoped claim: only a payment still awaiting review can be settled,
  // and two concurrent decisions can't both win.
  const claim = await prisma.payment.updateMany({
    where: { id: paymentId, status: "refund_pending" },
    data: { status: nextStatus },
  });
  if (claim.count === 0) {
    const exists = await prisma.payment.findUnique({ where: { id: paymentId } });
    return { ok: false, reason: exists ? "not_pending" : "not_found" };
  }
  return { ok: true };
}

// The customer hears about their approved refund by email (outbox-gated).
async function notifyRefundApproved(payment: {
  id: string;
  orderId: string;
  userId: string;
  amount: number;
}) {
  const order = await prisma.order.findUnique({
    where: { id: payment.orderId },
    select: { title: true },
  });
  await enqueueNotification(
    payment.userId,
    "orders.refund_approved",
    {
      title: order?.title ?? "your order",
      amount: `₹${Math.round(payment.amount / 100)}`,
      orderId: payment.orderId,
    },
    { dedupeKey: `refund_approved:${payment.id}` },
  ).catch(() => {});
}

export async function approveRefund(paymentId: string): Promise<RefundResult> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return { ok: false, reason: "not_found" };
  if (payment.status !== "refund_pending") return { ok: false, reason: "not_pending" };

  if (cashfreeConfigured) {
    // Real money: the gateway moves it first; we mark refunded only after it
    // accepts.
    //
    // The payment is claimed before the gateway is called. It used to stay
    // awaiting review while Cashfree answered, so a reject pressed in those
    // seconds won: the customer was refunded and the books said the charge
    // was kept. Claimed, a reject or a second approval finds nothing to
    // decide. refund_id is still our payment id, so Cashfree would refuse a
    // duplicate even if one got through.
    const claim = await prisma.payment.updateMany({
      where: { id: paymentId, status: "refund_pending" },
      data: { status: "refund_processing" },
    });
    if (claim.count === 0) return { ok: false, reason: "not_pending" };
    try {
      const refund = await createCashfreeRefund({
        orderId: payment.orderId,
        refundId: payment.id,
        amountRupees: payment.amount / 100,
      });
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: "refunded",
          gatewayResponse: JSON.stringify({
            refund: {
              cf_refund_id: refund.cf_refund_id,
              refund_status: refund.refund_status,
              refund_amount: refund.refund_amount,
            },
          }),
        },
      });
      void notifyRefundApproved(payment);
      return { ok: true };
    } catch (err) {
      // Nothing moved, so it goes back in the queue for a person to decide
      // again, and ops sees why rather than believing money moved.
      await prisma.payment
        .updateMany({
          where: { id: paymentId, status: "refund_processing" },
          data: { status: "refund_pending" },
        })
        .catch(() => {});
      return {
        ok: false,
        reason: "gateway_failed",
        message: err instanceof Error ? err.message : "Gateway refund failed",
      };
    }
  }

  // No gateway configured: DB-only settlement is a dev/demo convenience and
  // must never masquerade as a real refund in production.
  if (isProd) {
    return {
      ok: false,
      reason: "gateway_failed",
      message: "Refunds require the payment gateway to be configured in production",
    };
  }
  const settled = await settleRefund(paymentId, "refunded");
  if (settled.ok) void notifyRefundApproved(payment);
  return settled;
}

export async function rejectRefund(paymentId: string): Promise<RefundResult> {
  return settleRefund(paymentId, "success");
}

// --- CSV exports ------------------------------------------------------------
// Founder-grade data pulls. Values are quoted/escaped; money stays integer paise
// plus a rupee column for spreadsheet friendliness.

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Formula-injection guard: a cell starting with = + - @ (or a tab/CR remnant)
  // executes as a formula in Excel/Sheets. Titles and names are user-controlled,
  // and the person opening these exports is a super-admin — prefix a ' so
  // spreadsheet apps render it as literal text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export async function ordersCsv(): Promise<string> {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { email: true } },
      payment: { select: { status: true, method: true } },
    },
  });
  return toCsv(
    ["order_id", "created_at", "domain", "provider", "status", "payment_status", "method", "amount_paise", "amount_rupees", "saved_paise", "user_email", "title"],
    orders.map((o) => [
      o.id,
      o.createdAt.toISOString(),
      o.domain,
      o.provider,
      o.status,
      o.payment?.status ?? "",
      o.payment?.method ?? "",
      o.amount,
      (o.amount / 100).toFixed(2),
      o.savedPaise,
      o.user.email,
      o.title,
    ]),
  );
}

export async function usersCsv(): Promise<string> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      emailVerified: true,
      plusActive: true,
      role: true,
      createdAt: true,
      _count: { select: { orders: true } },
    },
  });
  return toCsv(
    ["user_id", "name", "email", "phone", "verified", "plus", "role", "orders", "joined_at"],
    users.map((u) => [
      u.id,
      u.name,
      u.email,
      u.phone ?? "",
      u.emailVerified,
      u.plusActive,
      u.role,
      u._count.orders,
      u.createdAt.toISOString(),
    ]),
  );
}

// --- Full audit viewer ---------------------------------------------------

export async function auditPage(opts: { action?: string; page?: number }) {
  const page = Math.max(1, opts.page ?? 1);
  const size = 50;
  const where = opts.action ? { action: opts.action } : {};
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * size,
      take: size,
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { logs, total, page, pageSize: size };
}
