import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { sendPrebuiltEmail } from "../../lib/mailer.js";
import { notificationEmail } from "../../lib/emailTemplates.js";
import { istStartOfDay, istYearMonth } from "../../lib/istTime.js";

// ---------------------------------------------------------------------------
// Email-notification outbox.
//
// Every non-OTP email is enqueued as a Notification row and drained by the
// worker below. That buys us, in one place: idempotency (dedupeKey),
// per-category preference gating, a per-user daily cap so no bug can carpet-
// bomb an inbox, and retries with a terminal `failed` state. Adding a new
// email = add a registry entry + call `enqueueNotification` from the event.
// ---------------------------------------------------------------------------

export type NotificationCategory = "security" | "orders" | "money" | "tips";

type Payload = Record<string, string>;

type RegistryEntry = {
  category: NotificationCategory;
  build: (p: Payload) => {
    subject: string;
    heading: string;
    lines: string[];
    ctaLabel?: string;
    ctaPath?: string;
    footnote?: string;
  };
};

const SECURITY_FOOTNOTE =
  "If this wasn't you, reset your password immediately and contact support from the Help section.";

// No `Record<string, …>` annotation here on purpose: it would widen the keys to
// `string` and lose compile-time safety. `satisfies` validates every entry
// against RegistryEntry while preserving the literal keys, which then become
// the NotificationType union below.
export const NOTIFICATION_TYPES = {
  // ONDC IGM: the complaint acknowledgement the Complaint Submitted screen
  // promises. Filed under security so it is never suppressed by the marketing
  // preferences, a grievance receipt is not an update the customer opted into.
  "complaint.raised": {
    category: "security",
    build: (p) => ({
      subject: `Complaint ${p.code} received`,
      heading: "We've got your complaint",
      lines: [
        `Your complaint reference is ${p.code}.`,
        "We've passed it to the seller and will update you as they respond.",
        "You can follow its progress at any time.",
      ],
      ctaLabel: "Track complaint",
      ctaPath: `/complaints/${p.complaintId}`,
    }),
  },
  "security.password_changed": {
    category: "security",
    build: () => ({
      subject: "Your Flouna password was changed",
      heading: "Password changed",
      lines: [
        "The password for your Flouna account was just changed.",
        "If you did this, you're all set, no action needed.",
      ],
      ctaLabel: "Review account",
      ctaPath: "/profile/settings",
      footnote: SECURITY_FOOTNOTE,
    }),
  },
  "security.address_added": {
    category: "security",
    build: (p) => ({
      subject: "A delivery address was added to your account",
      heading: "New address on your account",
      lines: [
        `A new delivery address${p.label ? ` ("${p.label}")` : ""} was just saved to your Flouna account.`,
        "If you added it, ignore this email.",
      ],
      ctaLabel: "View addresses",
      ctaPath: "/profile/addresses",
      footnote: SECURITY_FOOTNOTE,
    }),
  },
  "security.suspicious_login": {
    category: "security",
    build: (p) => ({
      subject: "Your Flouna account was just accessed",
      heading: "Sign-in after failed attempts",
      lines: [
        `Someone signed in to your account${p.attempts ? ` after ${p.attempts} failed password attempt${p.attempts === "1" ? "" : "s"}` : ""}.`,
        "If that was you, no action is needed, you can ignore this email.",
      ],
      ctaLabel: "Secure my account",
      ctaPath: "/profile/settings",
      footnote: SECURITY_FOOTNOTE,
    }),
  },
  "security.account_deletion_requested": {
    category: "security",
    build: () => ({
      subject: "Your Flouna account is scheduled for deletion",
      heading: "Account deletion requested",
      lines: [
        "We've received a request to delete your Flouna account. It will be permanently removed after a 7-day grace period.",
        "Changed your mind? Sign in any time in the next 7 days to keep your account and cancel the deletion.",
      ],
      ctaLabel: "Keep my account",
      ctaPath: "/profile/settings",
      footnote:
        "If you didn't request this, sign in immediately and change your password, someone may have access to your account.",
    }),
  },
  "orders.refund_approved": {
    category: "orders",
    build: (p) => ({
      subject: `Refund approved, ${p.title ?? "your order"}`,
      heading: "Your refund is on its way",
      lines: [
        `Your refund for ${p.title ?? "your order"}${p.amount ? ` (${p.amount})` : ""} has been approved.`,
        "The money returns to your original payment method, usually within 5 to 7 business days.",
      ],
      ctaLabel: "View order",
      ctaPath: p.orderId ? `/orders/${p.orderId}` : "/history",
    }),
  },
  "orders.cancelled": {
    category: "orders",
    build: (p) => ({
      subject: `Order cancelled, ${p.title ?? "your order"}`,
      heading: "Your order was cancelled",
      lines: [
        `${p.title ?? "Your order"} has been cancelled${p.reason ? ` (${p.reason})` : ""}.`,
        "If you already paid, the refund is being processed automatically.",
      ],
      ctaLabel: "View details",
      ctaPath: p.orderId ? `/orders/${p.orderId}` : "/history",
    }),
  },
  "plus.activated": {
    category: "orders", // subscription receipts ride the transactional gate
    build: (p) => ({
      subject: "Welcome to Flouna Plus 🎉",
      heading: "Your Plus membership is active",
      lines: [
        `Flouna Plus is now active${p.until ? ` until ${p.until}` : ""}. You're unlocking deeper AI picks, price-drop alerts, zero convenience fees and the savings guarantee.`,
        "We'll email you before your next renewal so there are never any surprises.",
      ],
      ctaLabel: "Explore Plus",
      ctaPath: "/profile/plus",
    }),
  },
  "plus.renewal_reminder": {
    category: "orders",
    build: (p) => ({
      subject: "Your Flouna Plus renews soon",
      heading: "Heads up. Plus renews in 3 days",
      lines: [
        `Your Flouna Plus membership renews${p.until ? ` on ${p.until}` : " soon"} for ${p.price ?? "₹50"}.`,
        "Nothing to do if you'd like to continue. If not, you can cancel any time before then.",
      ],
      ctaLabel: "Manage membership",
      ctaPath: "/profile/plus",
    }),
  },
  "plus.payment_failed": {
    category: "orders",
    build: () => ({
      subject: "We couldn't renew your Flouna Plus",
      heading: "Your Plus renewal didn't go through",
      lines: [
        "We tried to renew your Flouna Plus membership but the payment didn't succeed.",
        "Update your payment method to keep your Plus perks, we'll retry automatically.",
      ],
      ctaLabel: "Fix payment",
      ctaPath: "/profile/plus",
    }),
  },
  "plus.expired": {
    category: "orders",
    build: () => ({
      subject: "Your Flouna Plus has ended",
      heading: "Your Plus membership expired",
      lines: [
        "Your Flouna Plus membership has ended. Core Flouna, best-pick AI, live tracking and OTP, stays free, always.",
        "Renew any time to bring back deeper AI, price-drop alerts and the savings guarantee.",
      ],
      ctaLabel: "Renew Plus",
      ctaPath: "/profile/plus",
    }),
  },
  "money.savings_milestone": {
    category: "money",
    build: (p) => ({
      subject: `You've saved ${p.amount} with Flouna 🎉`,
      heading: `${p.amount} saved, nice going!`,
      lines: [
        `Your lifetime savings on Flouna just crossed ${p.amount}.`,
        "Every order compares prices across platforms so you always pay the least.",
      ],
      ctaLabel: "See your savings",
      ctaPath: "/history",
    }),
  },
  "money.price_drop": {
    category: "money",
    build: (p) => ({
      subject: `Price drop: ${p.item ?? "an item you're watching"} is now ${p.price ?? "cheaper"}`,
      heading: "A price you're watching just dropped",
      lines: [
        `${p.item ?? "An item on your watch-list"} has fallen to ${p.price ?? "your target"}${p.target ? `, at or below your ${p.target} target` : ""}.`,
        "Prices move fast, grab it while it lasts.",
      ],
      ctaLabel: "Order now",
      ctaPath: p.domain === "ride" ? "/rides" : "/food",
    }),
  },
  "money.plus_value": {
    category: "money",
    build: (p) => ({
      subject: p.active
        ? "Your Flouna Plus is paying off"
        : `You'd have saved ${p.wouldSave ?? "more"} with Plus`,
      heading: p.active
        ? "Plus is working for you"
        : "See what Plus could save you",
      lines: p.active
        ? [
            `This month your Flouna Plus saved you ${p.saved ?? "more than its cost"} in waived fees and better picks.`,
            "That's the membership paying for itself, keep enjoying it.",
          ]
        : [
            `Over the last month you'd have saved about ${p.wouldSave ?? "₹50+"} with Flouna Plus, waived convenience fees plus deeper price comparison.`,
            "Plus is ₹50/month and comes with a saved-you-more-than-₹50 guarantee.",
          ],
      ctaLabel: p.active ? "View membership" : "Try Plus",
      ctaPath: "/profile/plus",
    }),
  },
  "tips.onboarding_no_order": {
    category: "tips",
    build: () => ({
      subject: "Your first pick is waiting on Flouna",
      heading: "Let Flouna find your best deal",
      lines: [
        "You signed up but haven't placed your first order yet. Flouna compares prices across platforms and books the cheapest, you just ask.",
        'Try: "order a biryani under ₹300" or "book a cab to the airport".',
      ],
      ctaLabel: "Make your first pick",
      ctaPath: "/home",
    }),
  },
  "tips.win_back": {
    category: "tips",
    build: (p) => ({
      subject: "We've missed you at Flouna",
      heading: "Come back to smarter ordering",
      lines: [
        `It's been a while! Flouna is still comparing prices so you always pay the least.${p.usual ? ` Your usual, ${p.usual}, is one tap away.` : ""}`,
        "Pick up right where you left off.",
      ],
      ctaLabel: "Open Flouna",
      ctaPath: "/home",
    }),
  },
  "tips.feature_announcement": {
    category: "tips",
    build: (p) => ({
      subject: p.subject ?? "New on Flouna",
      heading: p.heading ?? "New on Flouna",
      lines: [p.body ?? ""],
      ctaLabel: p.ctaLabel,
      ctaPath: p.ctaPath,
    }),
  },
} satisfies Record<string, RegistryEntry>;

// Every registered notification type, derived from the registry itself, add an
// entry above and it becomes callable; typo one at a call site and it fails to
// compile rather than at runtime.
export type NotificationType = keyof typeof NOTIFICATION_TYPES;

// Lifetime-savings milestones (paise). Crossing one emails once.
export const SAVINGS_MILESTONES_PAISE = [50_000, 100_000, 500_000];

// Non-security emails per user per day, across categories. Security mail is
// never capped.
const DAILY_CAP = 8;
const MAX_ATTEMPTS = 3;
const BATCH = 25;

// Test hook, what the worker "delivered", visible to assertions.
export const outboxDelivered: Array<{ to: string; type: string; subject: string }> =
  [];

// Called after a payment succeeds. If the user's lifetime savings just crossed
// a milestone, email them once (dedupeKey per milestone makes it idempotent
// even though we recompute the running total each time).
export async function checkSavingsMilestone(userId: string): Promise<void> {
  // The same definition of "saved" the Savings screen uses: money kept on an
  // order that was actually paid for. This summed every order ever created,
  // including the ones abandoned at the payment screen and the ones cancelled,
  // so the email congratulated people on savings the app itself reported as
  // zero — and anyone could set it off by starting orders and never paying for
  // one. Worse than a wrong email: the milestone's dedupe key is burned by the
  // false crossing, so the real one is never announced at all.
  const agg = await prisma.order.aggregate({
    where: { userId, status: { in: ["confirmed", "in_progress", "completed"] } },
    _sum: { savedPaise: true },
  });
  const total = agg._sum.savedPaise ?? 0;
  // Highest milestone the running total has reached.
  const reached = [...SAVINGS_MILESTONES_PAISE]
    .reverse()
    .find((m) => total >= m);
  if (!reached) return;
  await enqueueNotification(
    userId,
    "money.savings_milestone",
    { amount: `₹${Math.round(reached / 100)}` },
    { dedupeKey: `savings:${userId}:${reached}` },
  ).catch(() => {});
}

export async function enqueueNotification(
  userId: string,
  type: NotificationType,
  payload: Payload = {},
  opts: { dedupeKey?: string } = {},
) {
  if (!NOTIFICATION_TYPES[type]) {
    // Unknown type is a programming error, fail loudly in dev/test, softly in prod.
    const msg = `[outbox] unknown notification type "${type}"`;
    if (env.NODE_ENV === "production") {
      console.error(msg);
      return null;
    }
    throw new Error(msg);
  }
  try {
    return await prisma.notification.create({
      data: {
        userId,
        type,
        payload: JSON.stringify(payload),
        dedupeKey: opts.dedupeKey ?? null,
      },
    });
  } catch (err) {
    // Unique violation on dedupeKey → already queued/sent once. That's the point.
    if ((err as { code?: string }).code === "P2002") return null;
    throw err;
  }
}

// `userId` scopes the drain to one recipient. Production never passes it (the
// worker drains everything); tests use it so parallel test files sharing a
// database can't claim each other's rows.
export async function drainOutbox(opts: { userId?: string } = {}) {
  // Claim rows before sending. Without this, a slow SMTP send keeps rows in
  // `queued` past the next 30s tick, and an overlapping drain (or a second
  // app instance) would pick the same row up and send the email twice. The
  // status-scoped updateMany is atomic, so exactly one worker wins each row.
  const candidates = await prisma.notification.findMany({
    where: {
      status: "queued",
      attempts: { lt: MAX_ATTEMPTS },
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: { id: true },
  });
  if (candidates.length === 0) return 0;

  const claimed: string[] = [];
  for (const c of candidates) {
    const res = await prisma.notification.updateMany({
      where: { id: c.id, status: "queued" },
      data: { status: "sending" },
    });
    if (res.count === 1) claimed.push(c.id);
  }
  if (claimed.length === 0) return 0;

  const batch = await prisma.notification.findMany({
    where: { id: { in: claimed } },
    orderBy: { createdAt: "asc" },
    include: {
      user: {
        select: {
          email: true,
          emailUpdates: true,
          emailMoneyUpdates: true,
          emailTips: true,
        },
      },
    },
  });

  for (const n of batch) {
    // `n.type` is a plain string from the DB, so the runtime guard stays: a row
    // written by an older deploy (type since removed) must fail, not crash.
    const entry = (NOTIFICATION_TYPES as Record<string, RegistryEntry>)[n.type];
    if (!entry) {
      await mark(n.id, "failed", "unknown type");
      continue;
    }

    // Category gate, security always sends.
    const gates: Record<NotificationCategory, boolean> = {
      security: true,
      orders: n.user.emailUpdates,
      money: n.user.emailMoneyUpdates,
      tips: n.user.emailTips,
    };
    if (!gates[entry.category]) {
      await mark(n.id, "skipped", "preference off");
      continue;
    }

    // Daily cap for everything except security.
    if (entry.category !== "security") {
      // Their day, so the cap resets at midnight in India rather than at
      // half past five in the morning.
      const since = istStartOfDay();
      const sentToday = await prisma.notification.count({
        where: { userId: n.userId, status: "sent", sentAt: { gte: since } },
      });
      if (sentToday >= DAILY_CAP) {
        await mark(n.id, "skipped", "daily cap");
        continue;
      }
    }

    try {
      const mail = notificationEmail({
        ...entry.build(JSON.parse(n.payload) as Payload),
      });
      await sendPrebuiltEmail(n.user.email, mail);
      if (env.NODE_ENV === "test") {
        outboxDelivered.push({ to: n.user.email, type: n.type, subject: mail.subject });
      }
      await prisma.notification.update({
        where: { id: n.id },
        data: { status: "sent", sentAt: new Date(), error: null },
      });
    } catch (err) {
      const attempts = n.attempts + 1;
      await prisma.notification.update({
        where: { id: n.id },
        data: {
          attempts,
          status: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return batch.length;
}

function mark(id: string, status: string, error: string) {
  return prisma.notification.update({ where: { id }, data: { status, error } });
}

// Daily lifecycle sweep, enqueues engagement emails on time-based rules. All
// idempotent via dedupeKey so repeated runs (or restarts) never double-send.
//   • onboarding nudge: signed up ~3 days ago, never ordered
//   • win-back: last order ~30 days ago
//   • Plus value: monthly ROI (subscribers) / upsell (non-subscribers)
export async function runLifecycleSweep(now = new Date()): Promise<{
  onboarding: number;
  winBack: number;
  plusValue: number;
}> {
  const day = 24 * 60 * 60 * 1000;
  let onboarding = 0;
  let winBack = 0;
  let plusValue = 0;

  // --- Onboarding: verified users who joined 34 days ago with zero orders.
  const joinedFrom = new Date(now.getTime() - 4 * day);
  const joinedTo = new Date(now.getTime() - 3 * day);
  const newbies = await prisma.user.findMany({
    where: {
      emailVerified: true,
      createdAt: { gte: joinedFrom, lte: joinedTo },
      orders: { none: {} },
    },
    select: { id: true },
    take: 500,
  });
  for (const u of newbies) {
    const res = await enqueueNotification(
      u.id,
      "tips.onboarding_no_order",
      {},
      { dedupeKey: `onboarding:${u.id}` },
    );
    if (res) onboarding++;
  }

  // --- Win-back: users whose most recent order was ~30 days ago. One nudge per
  // 30-day-inactivity window (keyed to the order date so it can re-fire later).
  const staleFrom = new Date(now.getTime() - 31 * day);
  const staleTo = new Date(now.getTime() - 30 * day);
  const recentOrders = await prisma.order.findMany({
    where: { createdAt: { gte: staleFrom, lte: staleTo } },
    select: { userId: true, title: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  const seen = new Set<string>();
  for (const o of recentOrders) {
    if (seen.has(o.userId)) continue;
    seen.add(o.userId);
    // Skip if they've ordered since the stale window.
    const newer = await prisma.order.count({
      where: { userId: o.userId, createdAt: { gt: staleTo } },
    });
    if (newer > 0) continue;
    const res = await enqueueNotification(
      o.userId,
      "tips.win_back",
      { usual: o.title },
      { dedupeKey: `winback:${o.userId}:${o.createdAt.toISOString().slice(0, 10)}` },
    );
    if (res) winBack++;
  }

  // --- Plus value: a monthly ROI touch for active members, bucketed by
  // calendar month so it's sent at most once per user per month. (The
  // non-subscriber "you'd have saved ₹X" upsell branch of money.plus_value is
  // intentionally NOT blasted here, it needs a real per-user counterfactual
  // savings figure to be honest, and monthly mail to every free user would hurt
  // domain deliverability. It's triggered case-by-case instead.)
  // The Indian calendar month. The host's, on a UTC server, changes month five
  // and a half hours late, so around the 1st this sent twice or not at all.
  const { year, month } = istYearMonth(now);
  const monthKey = `${year}-${month}`;
  const activePlus = await prisma.user.findMany({
    where: { plusActive: true, plusUntil: { gt: now } },
    select: { id: true },
    take: 500,
  });
  for (const u of activePlus) {
    const res = await enqueueNotification(
      u.id,
      "money.plus_value",
      { active: "1" },
      { dedupeKey: `plusvalue:${u.id}:${monthKey}` },
    );
    if (res) plusValue++;
  }

  return { onboarding, winBack, plusValue };
}

// Rows claimed (`sending`) but never resolved, the process died mid-send, or
// an SMTP call hung past its timeout. Return them to the queue so they retry
// instead of being stranded. Older than 10 min is safely past any send.
const STALE_CLAIM_MS = 10 * 60_000;

export async function requeueStaleClaims(now = new Date()): Promise<number> {
  const res = await prisma.notification.updateMany({
    where: {
      status: "sending",
      createdAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
    },
    data: { status: "queued" },
  });
  return res.count;
}

export function startOutboxWorker(intervalMs = 30_000) {
  // Non-reentrant: a drain that outlives the tick (slow SMTP) must not have a
  // second drain start underneath it.
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void requeueStaleClaims()
      .then(() => drainOutbox())
      .catch((err) => console.error("[outbox] drain failed:", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
