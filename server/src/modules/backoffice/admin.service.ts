// Admin operations service — read models + safe mutations for the operations
// console. Everything here is scoped to what support/ops staff legitimately need
// (users, orders, disputes, analytics) and exposes no secrets. Money stays in
// integer paise; we never recompute or move money here — refunds are flagged for
// the payment gateway, which is the only place value actually changes.

import { prisma } from "../../lib/prisma.js";

const PAGE = 25;

// --- Users ---------------------------------------------------------------

export async function searchUsers(opts: { q?: string; page?: number }) {
  const page = Math.max(1, opts.page ?? 1);
  const q = opts.q?.trim();
  const where = q
    ? {
        OR: [
          { email: { contains: q } },
          { name: { contains: q } },
          { phone: { contains: q } },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE,
      take: PAGE,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        emailVerified: true,
        plusActive: true,
        suspendedAt: true,
        createdAt: true,
        _count: { select: { orders: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      emailVerified: u.emailVerified,
      plusActive: u.plusActive,
      suspended: Boolean(u.suspendedAt),
      orderCount: u._count.orders,
      createdAt: u.createdAt,
    })),
    total,
    page,
    pageSize: PAGE,
  };
}

export async function getUserDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      emailVerified: true,
      phoneVerified: true,
      plusActive: true,
      plusUntil: true,
      weeklyFoodBudgetPaise: true,
      suspendedAt: true,
      createdAt: true,
    },
  });
  if (!user) return null;

  const [orders, totalSpentAgg, savedAgg] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        domain: true,
        status: true,
        title: true,
        amount: true,
        createdAt: true,
      },
    }),
    prisma.order.aggregate({
      where: { userId, status: { in: ["confirmed", "in_progress", "completed"] } },
      _sum: { amount: true },
    }),
    prisma.order.aggregate({ where: { userId }, _sum: { savedPaise: true } }),
  ]);

  return {
    user: { ...user, suspended: Boolean(user.suspendedAt) },
    recentOrders: orders,
    lifetimeSpentPaise: totalSpentAgg._sum.amount ?? 0,
    lifetimeSavedPaise: savedAgg._sum.savedPaise ?? 0,
  };
}

// Suspend / reinstate an ORDINARY user account (e.g. abuse). Operator-role
// suspension is a super-admin concern and lives in that module, so this guards
// against an admin touching another operator here.
export async function setUserSuspended(userId: string, suspended: boolean) {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!target) return { ok: false as const, reason: "not_found" as const };
  if (target.role !== "user") {
    return { ok: false as const, reason: "is_operator" as const };
  }
  await prisma.user.update({
    where: { id: userId },
    data: { suspendedAt: suspended ? new Date() : null },
  });
  return { ok: true as const };
}

// --- Orders --------------------------------------------------------------

export async function listOrders(opts: {
  status?: string;
  domain?: string;
  page?: number;
}) {
  const page = Math.max(1, opts.page ?? 1);
  const where: Record<string, unknown> = {};
  if (opts.status) where.status = opts.status;
  if (opts.domain) where.domain = opts.domain;

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE,
      take: PAGE,
      select: {
        id: true,
        domain: true,
        status: true,
        provider: true,
        title: true,
        amount: true,
        savedPaise: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
        payment: { select: { status: true, method: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return { orders: rows, total, page, pageSize: PAGE };
}

// Flag an order for a refund. We do NOT move money here — that requires the
// payment gateway (Cashfree) and only happens once live. This records the
// intent on the payment + raises/links a ticket so it's tracked end to end.
export async function flagRefund(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      title: true,
      payment: { select: { id: true, status: true, amount: true } },
    },
  });
  if (!order) return { ok: false as const, reason: "not_found" as const };
  // A zero rupee payment took nothing through the gateway (the wallet paid),
  // so there is nothing for Cashfree to refund; a flag would sit in the queue
  // failing for ever.
  if (!order.payment || order.payment.status !== "success" || order.payment.amount <= 0) {
    return { ok: false as const, reason: "not_refundable" as const };
  }
  // "refund_pending" is a review state distinct from the gateway's "refunded".
  await prisma.payment.update({
    where: { id: order.payment.id },
    data: { status: "refund_pending" },
  });
  return { ok: true as const, userId: order.userId, title: order.title };
}

// --- Analytics -----------------------------------------------------------

export async function adminAnalytics() {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const paid = { status: { in: ["confirmed", "in_progress", "completed"] } };

  const [
    totalUsers,
    newUsers7d,
    plusUsers,
    totalOrders,
    ordersByStatus,
    revenueAgg,
    revenue7dAgg,
    savedAgg,
    openTickets,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.user.count({ where: { plusActive: true } }),
    prisma.order.count(),
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.order.aggregate({ where: paid, _sum: { amount: true } }),
    prisma.order.aggregate({
      where: { ...paid, createdAt: { gte: since } },
      _sum: { amount: true },
    }),
    prisma.order.aggregate({ _sum: { savedPaise: true } }),
    prisma.supportTicket.count({ where: { status: { in: ["open", "in_progress"] } } }),
  ]);

  return {
    users: { total: totalUsers, new7d: newUsers7d, plus: plusUsers },
    orders: {
      total: totalOrders,
      byStatus: Object.fromEntries(
        ordersByStatus.map((g) => [g.status, g._count._all]),
      ),
    },
    revenuePaise: revenueAgg._sum.amount ?? 0,
    revenue7dPaise: revenue7dAgg._sum.amount ?? 0,
    userSavedPaise: savedAgg._sum.savedPaise ?? 0,
    openTickets,
  };
}
