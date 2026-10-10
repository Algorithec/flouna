import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { registerChatDevice } from "../groups/chatDevices.service.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { quotesForDish } from "../food/food.service.js";
import { weeklyFoodBudget, startOfWeek } from "./budget.service.js";
import { buildDecisionProfile } from "../advisor/decisionProfile.service.js";
import { predictForUser } from "../advisor/prediction.service.js";
import { enqueueNotification } from "../notifications/outbox.service.js";
import {
  createTicket,
  listUserTickets,
  TICKET_CATEGORIES,
} from "../backoffice/tickets.service.js";
import { createOtp, consumeOtp } from "../auth/otp.js";
import { sendOtpEmail } from "../../lib/mailer.js";
import { verifyPassword } from "../../lib/tokens.js";
import { describeDevice } from "../../lib/device.js";
import { walletBalance, walletHistory } from "./wallet.service.js";
import { credentialLimiter, lookupLimiter } from "../../middleware/rateLimit.js";
import { istHour } from "../../lib/istTime.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

// --- Support tickets (user side) ---
// Raise a support / grievance ticket, optionally about one of their own orders.
usersRouter.post(
  "/tickets",
  validateBody(
    z.object({
      orderId: z.string().cuid().optional(),
      category: z.enum(TICKET_CATEGORIES),
      subject: z.string().trim().min(3).max(140),
      body: z.string().trim().min(5).max(2000),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const data = req.body as {
        orderId?: string;
        category: (typeof TICKET_CATEGORIES)[number];
        subject: string;
        body: string;
      };
      const result = await createTicket({ userId: req.userId!, ...data });
      if (!result.ok) throw new ApiError(404, "Order not found");
      res.status(201).json({ ticket: result.ticket });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- chat device identity ----------
//
// Registered against the ACCOUNT, not a conversation.
//
// A sender key distribution message carries the sender's chain at its current
// position, so a device that appears after a message was sent can never read
// that message. If registration only happened when someone opened a particular
// chat, a member who joined a group and read it ten minutes later would find
// everything said in between permanently locked. WhatsApp does not have that
// problem because your phone is known to your account before any group exists,
// which is what this route reproduces: sign in anywhere and your device is
// publishable to every conversation you are in.
usersRouter.post(
  "/chat-device",
  validateBody(
    z
      .object({
        deviceId: z.string().trim().min(8).max(64),
        publicKey: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .regex(/^[A-Za-z0-9+/=]+$/, "Expected base64"),
        signingKey: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .regex(/^[A-Za-z0-9+/=]+$/, "Expected base64"),
        label: z.string().trim().max(60).optional(),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const { deviceId, publicKey, signingKey, label } = req.body as {
        deviceId: string;
        publicKey: string;
        signingKey: string;
        label?: string;
      };

      const { device, rekeyed } = await registerChatDevice(req.userId!, {
        deviceId,
        publicKey,
        signingKey,
        label,
      });

      res.status(201).json({ device: { deviceId: device.deviceId, createdAt: device.createdAt }, rekeyed });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.get("/tickets", async (req, res, next) => {
  try {
    res.json({ tickets: await listUserTickets(req.userId!) });
  } catch (err) {
    next(err);
  }
});

usersRouter.patch(
  "/me",
  validateBody(
    z.object({
      name: z.string().trim().min(2).max(80).optional(),
      phone: z
        .string()
        .trim()
        .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number")
        .nullable()
        .optional(),
      // Stored as the browser's date-input format so it round-trips exactly.
      dateOfBirth: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
        .nullable()
        .optional(),
      gender: z.string().trim().max(32).nullable().optional(),
    })
      // Strict, like every other write route here. A field this schema does not
      // know was being accepted with a 200 and quietly dropped, so a caller
      // sending {"role":"super_admin"} was told it worked. Nothing was written,
      // but the day someone adds a column that shares a name with a request
      // field, silence becomes the vulnerability.
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const data = req.body as {
        name?: string;
        phone?: string | null;
        dateOfBirth?: string | null;
        gender?: string | null;
      };
      // A phone number is unique across accounts, so saving one somebody else
      // already has is the caller's problem and has an answer they can act on.
      // Nothing caught the unique violation, so Personal Information answered
      // "Internal server error" and the customer had no way to tell that the
      // number, rather than the app, was the thing that was wrong.
      if (data.phone) {
        const taken = await prisma.user.findFirst({
          where: { phone: data.phone, NOT: { id: req.userId! } },
          select: { id: true },
        });
        if (taken) {
          throw new ApiError(409, "That mobile number is already on another account");
        }
      }
      const user = await prisma.user.update({
        where: { id: req.userId! },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          // Changing the number resets verification until SMS OTP ships.
          ...(data.phone !== undefined
            ? { phone: data.phone, phoneVerified: false }
            : {}),
          ...(data.dateOfBirth !== undefined
            ? { dateOfBirth: data.dateOfBirth }
            : {}),
          ...(data.gender !== undefined ? { gender: data.gender } : {}),
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          emailVerified: true,
          phoneVerified: true,
          avatarUrl: true,
          dateOfBirth: true,
          gender: true,
        },
      }).catch((err: { code?: string }) => {
        // Two accounts claiming the same number at the same moment: the check
        // above passed for both and the index stopped one. Same answer.
        if (err?.code === "P2002") {
          throw new ApiError(409, "That mobile number is already on another account");
        }
        throw err;
      });
      res.json({ user });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- Budget Guardian ----------

usersRouter.get("/budget", async (req, res, next) => {
  try {
    res.json(await weeklyFoodBudget(req.userId!));
  } catch (err) {
    next(err);
  }
});

usersRouter.put(
  "/budget",
  validateBody(
    z.object({
      // rupees from the client; null clears the budget
      weeklyBudgetRupees: z.number().int().min(100).max(100000).nullable(),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { weeklyBudgetRupees } = req.body as { weeklyBudgetRupees: number | null };
      await prisma.user.update({
        where: { id: req.userId! },
        data: {
          weeklyFoodBudgetPaise:
            weeklyBudgetRupees === null ? null : weeklyBudgetRupees * 100,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- Notification preferences ----------

usersRouter.get("/preferences", async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId! },
      select: {
        emailUpdates: true,
        smartSuggestions: true,
        emailMoneyUpdates: true,
        emailTips: true,
        shareLocation: true,
        profileVisibility: true,
        activityStatus: true,
        twoFactorEnabled: true,
      },
    });
    const deviceLocks = await prisma.deviceLock.count({
      where: { userId: req.userId! },
    });
    res.json({ ...user, biometricLock: deviceLocks > 0 });
  } catch (err) {
    next(err);
  }
});

usersRouter.put(
  "/preferences",
  validateBody(
    z
      .object({
        emailUpdates: z.boolean().optional(),
        smartSuggestions: z.boolean().optional(),
        emailMoneyUpdates: z.boolean().optional(),
        emailTips: z.boolean().optional(),
        shareLocation: z.boolean().optional(),
        profileVisibility: z.enum(["everyone", "contacts", "nobody"]).optional(),
        activityStatus: z.boolean().optional(),
      })
      // Strict, not stripping: an unknown key here means the caller believes it
      // is setting something. Silently dropping it (the default) would answer
      // 200 to a request that changed nothing they asked for — worst of all for
      // a field like `role`, which is never settable from this surface.
      .strict()
      .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" }),
  ),
  async (req, res, next) => {
    try {
      const body = req.body as {
        emailUpdates?: boolean;
        smartSuggestions?: boolean;
        emailMoneyUpdates?: boolean;
        emailTips?: boolean;
        shareLocation?: boolean;
        profileVisibility?: "everyone" | "contacts" | "nobody";
        activityStatus?: boolean;
      };
      const user = await prisma.user.update({
        where: { id: req.userId! },
        data: body,
        select: {
          emailUpdates: true,
          smartSuggestions: true,
          emailMoneyUpdates: true,
          emailTips: true,
          shareLocation: true,
          profileVisibility: true,
          activityStatus: true,
          twoFactorEnabled: true,
        },
      });
      res.json(user);
    } catch (err) {
      next(err);
    }
  },
);

// ---------- Login activity (Privacy & Security) ----------
//
// Backed by the refresh tokens that already represent sessions, so this is the
// real list rather than a display: revoking here genuinely ends those sessions
// at their next refresh. The current session is identified by its own cookie so
// the caller can't accidentally sign themselves out of the device they're on.

usersRouter.get("/sessions", async (req, res, next) => {
  try {
    // Device details ride along so Login Activity can name each row. Which one
    // is the CALLER'S session can't be answered here: the refresh cookie is
    // scoped to /api/auth, so it isn't sent to this path. That flag, and
    // signing out a single device, live on the auth router for that reason.
    const sessions = await prisma.refreshToken.findMany({
      where: { userId: req.userId!, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        userAgent: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    // Counted separately — the list above is capped, so its length would
    // under-report anyone with more than 50 live sessions.
    const count = await prisma.refreshToken.count({
      where: { userId: req.userId!, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    res.json({ sessions, count });
  } catch (err) {
    next(err);
  }
});

// ---------- Rewards wallet (Offers & Rewards) ----------
//
// Balance and history come from the same ledger, so the number in the hero and
// the lines beneath it can never disagree.

usersRouter.get("/wallet", async (req, res, next) => {
  try {
    const [balancePaise, entries] = await Promise.all([
      walletBalance(req.userId!),
      walletHistory(req.userId!),
    ]);
    res.json({ balancePaise, entries });
  } catch (err) {
    next(err);
  }
});

// ---------- Blocked users (Privacy) ----------
//
// Enforced in the one place the product puts two accounts together: group
// carts. Blocking is one-directional in intent but symmetric in effect —
// neither side can join a cart the other hosts.

usersRouter.get("/blocked", async (req, res, next) => {
  try {
    const rows = await prisma.blockedUser.findMany({
      where: { userId: req.userId! },
      select: {
        id: true,
        createdAt: true,
        blockedUser: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      blocked: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        user: r.blockedUser,
      })),
    });
  } catch (err) {
    next(err);
  }
});

usersRouter.post(
  "/blocked",
  lookupLimiter,
  validateBody(z.object({ email: z.string().trim().email().max(200) }).strict()),
  async (req, res, next) => {
    try {
      const { email } = req.body as { email: string };
      const target = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true, name: true, email: true, avatarUrl: true },
      });
      // Deliberately the same answer whether the address has no account or the
      // block already exists: this endpoint must not become a way to test which
      // email addresses are registered.
      if (!target || target.id === req.userId!) {
        throw new ApiError(404, "No account uses that email address");
      }

      const row = await prisma.blockedUser.upsert({
        where: {
          userId_blockedUserId: { userId: req.userId!, blockedUserId: target.id },
        },
        create: { userId: req.userId!, blockedUserId: target.id },
        update: {},
        select: { id: true, createdAt: true },
      });
      res.status(201).json({ blocked: { id: row.id, createdAt: row.createdAt, user: target } });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.delete("/blocked/:id", async (req, res, next) => {
  try {
    const row = await prisma.blockedUser.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      select: { id: true },
    });
    if (!row) throw new ApiError(404, "Not found");
    await prisma.blockedUser.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Device lock (Biometric Lock) ----------
//
// The fingerprint/face check itself is done by the device's own platform
// authenticator through WebAuthn in the browser. What the server keeps is which
// devices have the lock armed, so the setting survives a reinstall and can be
// turned off from another device. This is an app lock, not a login factor — it
// never replaces the password or the session cookie.

usersRouter.get("/device-locks", async (req, res, next) => {
  try {
    const locks = await prisma.deviceLock.findMany({
      where: { userId: req.userId! },
      select: { id: true, credentialId: true, label: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ locks });
  } catch (err) {
    next(err);
  }
});

usersRouter.post(
  "/device-locks",
  validateBody(
    z.object({
      credentialId: z.string().min(8).max(600),
      label: z.string().trim().max(80).optional(),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { credentialId, label } = req.body as {
        credentialId: string;
        label?: string;
      };

      // credentialId is globally unique, so an upsert keyed on it alone would
      // hand back — and quietly refresh — a row belonging to somebody else.
      // Claim it only if it is unclaimed or already ours; anything else is a
      // flat conflict that reveals nothing about the owner.
      const existing = await prisma.deviceLock.findUnique({
        where: { credentialId },
        select: { id: true, userId: true },
      });
      if (existing && existing.userId !== req.userId!) {
        throw new ApiError(409, "That credential is already registered");
      }

      const lock = existing
        ? await prisma.deviceLock.update({
            where: { id: existing.id },
            data: { lastUsedAt: new Date() },
            select: { id: true, credentialId: true, label: true, createdAt: true },
          })
        : await prisma.deviceLock.create({
            data: {
              userId: req.userId!,
              credentialId,
              label: label ?? describeDevice(req.get("user-agent") ?? null),
            },
            select: { id: true, credentialId: true, label: true, createdAt: true },
          });
      res.status(201).json({ lock });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.delete("/device-locks", async (req, res, next) => {
  try {
    const { count } = await prisma.deviceLock.deleteMany({
      where: { userId: req.userId! },
    });
    res.json({ removed: count });
  } catch (err) {
    next(err);
  }
});

// ---------- Two-factor authentication ----------
//
// Email one-time code on top of the password, using the same OTP helpers the
// operator console's step-up runs on. Turning it ON requires proving control of
// the mailbox that will receive the codes, so a hijacked session can't quietly
// arm a factor the real owner can't satisfy. Turning it OFF requires the
// account password for the same reason in reverse.

usersRouter.post("/two-factor/start", credentialLimiter, async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId! },
      select: { email: true, twoFactorEnabled: true },
    });
    if (user.twoFactorEnabled) throw new ApiError(409, "Already turned on");
    const code = await createOtp({
      userId: req.userId!,
      channel: "email",
      target: user.email,
      purpose: "two_factor_setup",
    });
    await sendOtpEmail(user.email, code, "two_factor_setup");
    res.json({ sent: true, email: user.email });
  } catch (err) {
    next(err);
  }
});

usersRouter.post(
  "/two-factor/confirm",
  credentialLimiter,
  validateBody(z.object({ code: z.string().regex(/^\d{6}$/) }).strict()),
  async (req, res, next) => {
    try {
      const { code } = req.body as { code: string };
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: req.userId! },
        select: { email: true },
      });
      const ok = await consumeOtp({
        target: user.email,
        purpose: "two_factor_setup",
        code,
      });
      if (!ok) throw new ApiError(401, "Invalid or expired code");
      await prisma.user.update({
        where: { id: req.userId! },
        data: { twoFactorEnabled: true },
      });
      res.json({ twoFactorEnabled: true });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.post(
  "/two-factor/disable",
  credentialLimiter,
  validateBody(z.object({ password: z.string().min(1).max(128) }).strict()),
  async (req, res, next) => {
    try {
      const { password } = req.body as { password: string };
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: req.userId! },
        select: { passwordHash: true },
      });
      // Google-only accounts have no password to check; they also never see the
      // password login this factor guards, so there is nothing to disable.
      if (!user.passwordHash) throw new ApiError(400, "This account has no password");
      if (!(await verifyPassword(password, user.passwordHash))) {
        throw new ApiError(401, "Incorrect password");
      }
      await prisma.user.update({
        where: { id: req.userId! },
        data: { twoFactorEnabled: false },
      });
      res.json({ twoFactorEnabled: false });
    } catch (err) {
      next(err);
    }
  },
);

// Decision profile — the user's learned taste, spend behaviour and routines.
// Powers personalized recommendations and proactive nudges.
usersRouter.get("/profile", async (req, res, next) => {
  try {
    res.json(await buildDecisionProfile(req.userId!));
  } catch (err) {
    next(err);
  }
});

// Proactive predictions — heads-ups derived from the user's routines + live
// context (e.g. rain near their usual morning ride). Optional lat/lng sharpen
// the weather; without them we use the demo city centre. Always 200 with a
// (possibly empty) list — a quiet day simply has nothing to surface.
usersRouter.get("/predictions", async (req, res, next) => {
  try {
    const lat = req.query.lat != null ? Number(req.query.lat) : null;
    const lng = req.query.lng != null ? Number(req.query.lng) : null;
    const predictions = await predictForUser(req.userId!, {
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    });
    res.json({ predictions });
  } catch (err) {
    next(err);
  }
});

// Savings insights — lifetime total plus a 6-week trend and a food/ride split.
// All derived from paid orders' savedPaise (frozen at decision time).
usersRouter.get("/savings", async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        userId: req.userId!,
        status: { in: ["confirmed", "in_progress", "completed"] },
      },
      select: { savedPaise: true, domain: true, createdAt: true },
    });

    const totalSavedPaise = orders.reduce((s, o) => s + o.savedPaise, 0);

    // Per-domain split.
    const byDomain = { food: 0, ride: 0 };
    for (const o of orders) {
      if (o.domain === "food") byDomain.food += o.savedPaise;
      else if (o.domain === "ride") byDomain.ride += o.savedPaise;
    }

    // Last 6 weeks (oldest → newest), bucketed by Monday-start week.
    const WEEKS = 6;
    const thisWeek = startOfWeek();
    const weekly: { weekStart: string; savedPaise: number }[] = [];
    for (let i = WEEKS - 1; i >= 0; i--) {
      // Plain week arithmetic from an Indian Monday. Stepping with setDate
      // would have gone through the host's calendar, which drifts by an hour
      // across a daylight-saving boundary the rider does not observe.
      const WEEK_MS = 7 * 24 * 3_600_000;
      const start = new Date(thisWeek.getTime() - i * WEEK_MS);
      const end = new Date(start.getTime() + WEEK_MS);
      const savedPaise = orders
        .filter((o) => o.createdAt >= start && o.createdAt < end)
        .reduce((s, o) => s + o.savedPaise, 0);
      weekly.push({ weekStart: start.toISOString(), savedPaise });
    }

    res.json({
      totalSavedPaise,
      paidOrders: orders.length,
      byDomain,
      weekly,
    });
  } catch (err) {
    next(err);
  }
});

// "The usual": the dish this user pays for most often, with today's best
// price — powers one-tap reorder.
usersRouter.get("/usual", async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        userId: req.userId!,
        domain: "food",
        status: { in: ["confirmed", "in_progress", "completed"] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { details: true },
    });
    if (orders.length === 0) return res.json({ usual: null });

    const counts = new Map<string, number>();
    for (const o of orders) {
      try {
        const dishId = (JSON.parse(o.details) as { dishId?: string }).dishId;
        if (dishId) counts.set(dishId, (counts.get(dishId) ?? 0) + 1);
      } catch {
        // ignore malformed snapshots
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    // One-off orders aren't a habit yet.
    if (!top || top[1] < 2) return res.json({ usual: null });

    const [dishId, timesOrdered] = top;
    const bestNow = quotesForDish(dishId)[0];
    if (!bestNow) return res.json({ usual: null });

    res.json({ usual: { ...bestNow, timesOrdered } });
  } catch (err) {
    next(err);
  }
});

// ---------- Autonomous chat suggestions ----------
//
// The chat home shows three "smart chips". Instead of a fixed list, we build
// them from each user's own history — what they reorder, where they ride, and
// the time of day — so the screen feels personal. New users get sensible
// defaults. `icon` is a string key the web maps to an icon component (React
// components can't cross the JSON boundary).

type Suggestion = { label: string; prompt: string; icon: string; theme: string };

// Time-of-day food nudge — what most people are deciding right now.
function mealSuggestion(now = new Date()): Suggestion {
  // Their dinner time, not the host's. On a UTC server this offered lunch at
  // eight in the evening.
  const h = istHour(now);
  if (h < 11)
    return { label: "Breakfast picks", prompt: "Find me a quick breakfast under ₹150", icon: "coffee", theme: "amber" };
  if (h < 16)
    return { label: "Lunch under ₹200", prompt: "Best lunch near me under ₹200", icon: "utensils", theme: "orange" };
  if (h < 21)
    return { label: "Dinner ideas", prompt: "What's good for dinner tonight?", icon: "utensils", theme: "orange" };
  return { label: "Late-night bites", prompt: "Late-night food open now", icon: "moon", theme: "purple" };
}

// Pool of generic chips for filling empty slots (new users / sparse history).
const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { label: "Order pizza", prompt: "Order a pizza under ₹300", icon: "pizza", theme: "orange" },
  { label: "Book a ride", prompt: "Book a ride to ", icon: "mapPin", theme: "blue" },
  { label: "Shop a laptop", prompt: "Find me a gaming laptop under ₹70000", icon: "shoppingBag", theme: "purple" },
  { label: "Cheapest cab", prompt: "Find the cheapest cab right now", icon: "car", theme: "blue" },
  { label: "Veg thali", prompt: "Best veg thali near me", icon: "utensils", theme: "green" },
];

usersRouter.get("/suggestions", async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        userId: req.userId!,
        status: { in: ["confirmed", "in_progress", "completed"] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { domain: true, details: true },
    });

    const out: Suggestion[] = [];
    const seen = new Set<string>();
    const add = (s: Suggestion) => {
      if (out.length >= 3 || seen.has(s.label)) return;
      seen.add(s.label);
      out.push(s);
    };

    // 1) Reorder the dish they buy most (a real habit = ordered ≥ 2x).
    const dishCounts = new Map<string, { name: string; n: number }>();
    const dropCounts = new Map<string, number>();
    for (const o of orders) {
      try {
        const d = JSON.parse(o.details) as {
          dishId?: string;
          name?: string;
          drop?: string;
        };
        if (o.domain === "food" && d.dishId) {
          const cur = dishCounts.get(d.dishId);
          dishCounts.set(d.dishId, {
            name: d.name ?? cur?.name ?? "your usual",
            n: (cur?.n ?? 0) + 1,
          });
        }
        if (o.domain === "ride" && d.drop) {
          dropCounts.set(d.drop, (dropCounts.get(d.drop) ?? 0) + 1);
        }
      } catch {
        // ignore malformed snapshots
      }
    }

    const topDish = [...dishCounts.values()].sort((a, b) => b.n - a.n)[0];
    if (topDish && topDish.n >= 2) {
      add({
        label: `Reorder ${topDish.name}`,
        prompt: `Order ${topDish.name} again`,
        icon: "rotate",
        theme: "orange",
      });
    }

    // 2) Re-book a route they take often.
    const topDrop = [...dropCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topDrop && topDrop[1] >= 2) {
      add({
        label: `Ride to ${topDrop[0]}`,
        prompt: `Book a ride to ${topDrop[0]}`,
        icon: "mapPin",
        theme: "blue",
      });
    }

    // 3) Time-of-day meal nudge.
    add(mealSuggestion());

    // Fill any remaining slots with defaults (skipping duplicates by label).
    for (const s of DEFAULT_SUGGESTIONS) add(s);

    res.json({ suggestions: out.slice(0, 3) });
  } catch (err) {
    next(err);
  }
});

// ---------- addresses ----------

const addressBody = z.object({
  label: z.string().trim().min(1).max(30),
  line1: z.string().trim().min(1).max(160), // flat / house no.
  line2: z.string().trim().max(160).optional(), // building / street
  landmark: z.string().trim().max(120).optional(),
  contactName: z.string().trim().max(80).optional(),
  contactPhone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number")
    .optional(),
  city: z.string().trim().min(2).max(60),
  state: z.string().trim().min(2).max(60),
  pincode: z.string().trim().regex(/^\d{6}$/, "Enter a valid 6-digit PIN code"),
  // Captured by "Use current location" — powers delivery maps later.
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  isDefault: z.boolean().default(false),
});

usersRouter.get("/addresses", async (req, res, next) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.userId! },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
    res.json({ addresses });
  } catch (err) {
    next(err);
  }
});

usersRouter.post("/addresses", validateBody(addressBody), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof addressBody>;
    if (body.isDefault) {
      await prisma.address.updateMany({
        where: { userId: req.userId! },
        data: { isDefault: false },
      });
    }
    const address = await prisma.address.create({
      data: { ...body, userId: req.userId! },
    });
    // Security signal — account thieves change the delivery address first.
    // Awaited (it's one cheap insert) but never allowed to fail the request.
    await enqueueNotification(
      req.userId!,
      "security.address_added",
      { label: address.label },
      { dedupeKey: `address_added:${address.id}` },
    ).catch(() => {});
    res.status(201).json({ address });
  } catch (err) {
    next(err);
  }
});

// Update an existing address (the "Edit Address" screen). Same validation as
// create; ownership enforced by the compound where.
usersRouter.patch(
  "/addresses/:id",
  validateBody(addressBody),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof addressBody>;
      if (body.isDefault) {
        await prisma.address.updateMany({
          where: { userId: req.userId! },
          data: { isDefault: false },
        });
      }
      // Full-replace semantics: the edit form always sends the complete
      // address, so absent optional fields clear rather than linger.
      const updated = await prisma.address.updateMany({
        where: { id: req.params.id, userId: req.userId! },
        data: {
          ...body,
          line2: body.line2 ?? null,
          landmark: body.landmark ?? null,
          contactName: body.contactName ?? null,
          contactPhone: body.contactPhone ?? null,
          lat: body.lat ?? null,
          lng: body.lng ?? null,
        },
      });
      if (updated.count === 0) throw new ApiError(404, "Address not found");
      const address = await prisma.address.findUnique({ where: { id: req.params.id } });
      res.json({ address });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.delete("/addresses/:id", async (req, res, next) => {
  try {
    const deleted = await prisma.address.deleteMany({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (deleted.count === 0) throw new ApiError(404, "Address not found");
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Payment methods ---
// Deliberately not a card vault: a real charge still goes through Cashfree's
// own hosted checkout at payment time. This only ever stores what's needed
// to recognise a method in a list — a card's number and CVV are refused by
// the schema itself (there's no field for them), not just by convention.
const CARD_BRANDS = ["Visa", "Mastercard", "Rupay", "Amex"] as const;

const paymentMethodBody = z
  .object({
    type: z.enum(["card", "upi", "wallet"]),
    label: z.string().trim().min(1).max(40),
    last4: z
      .string()
      .regex(/^\d{4}$/, "Enter the last 4 digits")
      .optional(),
    expiryMonth: z.number().int().min(1).max(12).optional(),
    expiryYear: z
      .number()
      .int()
      .min(new Date().getFullYear())
      .max(new Date().getFullYear() + 20)
      .optional(),
    vpa: z
      .string()
      .trim()
      .regex(/^[\w.+-]{2,256}@[a-zA-Z]{2,64}$/, "Enter a valid UPI ID")
      .optional(),
    isDefault: z.boolean().default(false),
  })
  .refine(
    (b) => b.type !== "card" || (b.last4 && b.expiryMonth && b.expiryYear),
    { message: "Card methods need last4, expiryMonth and expiryYear" },
  )
  .refine((b) => b.type !== "upi" || b.vpa, {
    message: "UPI methods need a vpa",
  });

usersRouter.get("/payment-methods", async (req, res, next) => {
  try {
    const methods = await prisma.paymentMethod.findMany({
      where: { userId: req.userId! },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
    res.json({ methods });
  } catch (err) {
    next(err);
  }
});

usersRouter.post(
  "/payment-methods",
  validateBody(paymentMethodBody),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof paymentMethodBody>;
      if (body.type === "card" && !(CARD_BRANDS as readonly string[]).includes(body.label)) {
        throw new ApiError(400, `label must be one of: ${CARD_BRANDS.join(", ")}`);
      }
      // A list whose whole job is to let someone recognise a method is useless
      // with two identical rows in it — and a double tap on a slow connection
      // is the easiest way to get one. Matched on what the user actually sees:
      // the UPI id, or the brand plus last four and expiry.
      const duplicate = await prisma.paymentMethod.findFirst({
        where:
          body.type === "upi"
            ? { userId: req.userId!, type: "upi", vpa: body.vpa }
            : {
                userId: req.userId!,
                type: body.type,
                label: body.label,
                last4: body.last4 ?? null,
                expiryMonth: body.expiryMonth ?? null,
                expiryYear: body.expiryYear ?? null,
              },
        select: { id: true },
      });
      if (duplicate) {
        throw new ApiError(409, "That payment method is already saved");
      }

      if (body.isDefault) {
        await prisma.paymentMethod.updateMany({
          where: { userId: req.userId! },
          data: { isDefault: false },
        });
      }
      const method = await prisma.paymentMethod.create({
        data: {
          userId: req.userId!,
          type: body.type,
          label: body.label,
          last4: body.last4 ?? null,
          expiryMonth: body.expiryMonth ?? null,
          expiryYear: body.expiryYear ?? null,
          vpa: body.vpa ?? null,
          isDefault: body.isDefault,
        },
      });
      res.status(201).json({ method });
    } catch (err) {
      next(err);
    }
  },
);

usersRouter.patch("/payment-methods/:id/default", async (req, res, next) => {
  try {
    const owned = await prisma.paymentMethod.findFirst({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (!owned) throw new ApiError(404, "Payment method not found");
    await prisma.paymentMethod.updateMany({
      where: { userId: req.userId! },
      data: { isDefault: false },
    });
    const method = await prisma.paymentMethod.update({
      where: { id: owned.id },
      data: { isDefault: true },
    });
    res.json({ method });
  } catch (err) {
    next(err);
  }
});

usersRouter.delete("/payment-methods/:id", async (req, res, next) => {
  try {
    const deleted = await prisma.paymentMethod.deleteMany({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (deleted.count === 0) throw new ApiError(404, "Payment method not found");
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
