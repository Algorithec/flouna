// Flouna Plus (₹50/mo) — the premium tier.
//
// IMPORTANT: live ride tracking, the driver map, OTP and the core "best pick"
// AI are FREE for everyone. Plus adds value on top — it never removes core
// capability. The gated perks:
//   • deeper AI: unlimited comparisons, budget-aware picks, price-drop alerts
//   • zero in-app convenience fees
//   • monthly savings report + "saved you more than ₹50 or it's free" guarantee

import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { enqueueNotification } from "../notifications/outbox.service.js";
import { istDateLabel } from "../../lib/istTime.js";

// Human-friendly date for emails, e.g. "12 Aug 2026".
function fmtDate(d: Date): string {
  return istDateLabel(d);
}

export type PlusStatus = {
  active: boolean;
  since: string | null;
  until: string | null;
  pricePaise: number;
  perks: string[];
};

const PERKS = [
  "Unlimited AI comparisons & budget-aware picks",
  "Price-drop alerts across food, rides & shopping",
  "Zero in-app convenience fees",
  "Monthly savings report",
  "Saved-you-more-than-₹50 guarantee",
];

// A user is Plus iff the flag is on AND the period hasn't lapsed.
export function isPlusActive(user: {
  plusActive: boolean;
  plusUntil: Date | null;
}): boolean {
  if (!user.plusActive) return false;
  if (user.plusUntil && user.plusUntil.getTime() < Date.now()) return false;
  return true;
}

export async function getPlusStatus(userId: string): Promise<PlusStatus> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plusActive: true, plusSince: true, plusUntil: true },
  });
  const active = isPlusActive(user);
  return {
    active,
    since: user.plusSince?.toISOString() ?? null,
    until: user.plusUntil?.toISOString() ?? null,
    pricePaise: env.SUBSCRIPTION_PRICE_PAISE,
    perks: PERKS,
  };
}

// Activates a 30-day period. In production this is called after a successful
// Cashfree subscription charge; in dev it runs on a simulated activation.
export async function activatePlus(userId: string): Promise<PlusStatus> {
  const now = new Date();
  const until = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await prisma.user.update({
    where: { id: userId },
    data: { plusActive: true, plusSince: now, plusUntil: until },
  });
  // Membership receipt. dedupeKey is per period-end so re-activation within the
  // same period (idempotent webhook retries) won't double-send. Awaited so the
  // receipt is queued before the caller sees "active" (never fails activation).
  await enqueueNotification(
    userId,
    "plus.activated",
    { until: fmtDate(until) },
    { dedupeKey: `plus_activated:${userId}:${until.toISOString().slice(0, 10)}` },
  ).catch(() => {});
  return getPlusStatus(userId);
}

export async function cancelPlus(userId: string): Promise<PlusStatus> {
  await prisma.user.update({
    where: { id: userId },
    data: { plusActive: false },
  });
  return getPlusStatus(userId);
}

// Daily sweep over Plus memberships: remind ~3 days before renewal, and email
// once when a period lapses. Both are idempotent via dedupeKey, so running the
// sweep repeatedly (or across restarts) never double-sends.
//
// Returns a small tally for logging/observability.
export async function sweepPlusMemberships(now = new Date()): Promise<{
  reminded: number;
  expired: number;
}> {
  const priceLabel = `₹${Math.round(env.SUBSCRIPTION_PRICE_PAISE / 100)}`;

  // --- Renewal reminders: active members whose period ends in ~3 days.
  const windowStart = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const renewing = await prisma.user.findMany({
    where: {
      plusActive: true,
      plusUntil: { gte: windowStart, lte: windowEnd },
    },
    select: { id: true, plusUntil: true },
  });
  let reminded = 0;
  for (const u of renewing) {
    if (!u.plusUntil) continue;
    const res = await enqueueNotification(
      u.id,
      "plus.renewal_reminder",
      { until: fmtDate(u.plusUntil), price: priceLabel },
      // One reminder per period end.
      { dedupeKey: `plus_renewal:${u.id}:${u.plusUntil.toISOString().slice(0, 10)}` },
    );
    if (res) reminded++;
  }

  // --- Expiries: still-flagged members whose period has already lapsed. Email
  // once, then clear the flag so the app treats them as free immediately.
  const lapsed = await prisma.user.findMany({
    where: { plusActive: true, plusUntil: { lt: now } },
    select: { id: true, plusUntil: true },
  });
  let expired = 0;
  for (const u of lapsed) {
    await enqueueNotification(
      u.id,
      "plus.expired",
      {},
      {
        dedupeKey: `plus_expired:${u.id}:${u.plusUntil?.toISOString().slice(0, 10) ?? "na"}`,
      },
    ).catch(() => {});
    await prisma.user.update({
      where: { id: u.id },
      data: { plusActive: false },
    });
    expired++;
  }

  return { reminded, expired };
}

// Convenience fee charged on in-app orders for free users; waived for Plus.
// (Demonstrates a real, non-tracking perk that affects pricing.)
export const CONVENIENCE_FEE_PAISE = 700;
