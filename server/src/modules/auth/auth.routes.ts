import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../../lib/prisma.js";
import { meetsMinimumAge, MINIMUM_AGE_YEARS, POLICY_VERSION } from "../../lib/policy.js";
import { recordConsent } from "../compliance/consent.service.js";
import { sendOtpEmail, sendWelcomeEmail } from "../../lib/mailer.js";
import { enqueueNotification } from "../notifications/outbox.service.js";
import {
  clearAuthCookies,
  hashPassword,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  setAuthCookies,
  signAccessToken,
  verifyPassword,
  hashToken,
} from "../../lib/tokens.js";
import { validateBody } from "../../middleware/validate.js";
import { requireAuth } from "../../middleware/auth.js";
import { ApiError } from "../../middleware/error.js";
import { sessionLimiter } from "../../middleware/rateLimit.js";
import { consumeOtp, createOtp } from "./otp.js";
import { env } from "../../config/env.js";
import { normalizeRole, isOperator } from "../../lib/rbac.js";

export const authRouter = Router();

const googleClient = env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(env.GOOGLE_CLIENT_ID)
  : null;

// Strict limit on credential/OTP endpoints — slows brute force and OTP abuse.
// Relaxed under test so the suite isn't throttled by its own requests.
const sensitiveLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.NODE_ENV === "test" ? 1000 : 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128);

function publicUser(user: {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  avatarUrl: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  role?: string;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified,
    avatarUrl: user.avatarUrl,
    dateOfBirth: user.dateOfBirth ?? null,
    gender: user.gender ?? null,
    // Operator role for console routing; "user" for ordinary customers.
    role: normalizeRole(user.role),
  };
}

async function startSession(
  res: Parameters<typeof setAuthCookies>[0],
  userId: string,
  stepUp = false,
  /** Request the session is being started from, for Login Activity. */
  req?: { get(name: string): string | undefined; ip?: string },
) {
  // Bake the current role into the access token so ordinary requests carry it.
  // requireRole still re-checks the DB for privileged routes, so a stale token
  // can never grant access that was revoked. `stepUp` marks a session that has
  // cleared operator 2FA — set only by the console verify flow.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, suspendedAt: true },
  });
  // A suspended account gets no new session, whatever route asked for one.
  //
  // Suspension was enforced in exactly two places: requireRole, which only
  // operators ever reach, and /refresh. An ordinary customer suspended from
  // the admin console could therefore still sign in and keep ordering — the
  // refresh fifteen minutes later was refused, and logging in again handed
  // them another fifteen. Checked here rather than in each route because this
  // is the single door every session comes through: password login, the
  // two-factor second step, email verification, Google, and the console.
  if (user?.suspendedAt) throw new ApiError(403, "Account suspended");
  const access = signAccessToken(userId, normalizeRole(user?.role), stepUp);
  const refresh = await issueRefreshToken(userId, stepUp, {
    userAgent: req?.get("user-agent") ?? null,
    ip: req?.ip ?? null,
  });
  setAuthCookies(res, access, refresh);
}

// ---------- email + password signup with email OTP verification ----------

authRouter.post(
  "/signup",
  sensitiveLimit,
  validateBody(
    z.object({
      name: z.string().trim().min(2).max(80),
      email: emailSchema,
      password: passwordSchema,
      // Optional at sign-up. The form has always asked for these — they were
      // being discarded, so the account never kept what the user typed.
      phone: z
        .string()
        .trim()
        .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number")
        .optional(),
      // No longer optional. Terms 3.1 and Privacy 8.1 both set a floor of
      // 18, and an optional birth date is not an age check: it is a field
      // anyone under 18 can leave blank to get in.
      dateOfBirth: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
      // Consent has to be an act, so this must be sent and must be true. A
      // default of true would record an agreement the person never made,
      // which is worse than not recording one at all.
      acceptTerms: z.literal(true),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { name, email, password, phone, dateOfBirth } = req.body as {
        name: string;
        email: string;
        password: string;
        phone?: string;
        dateOfBirth: string;
      };

      // Checked on the server, not only in the form. The client control is a
      // courtesy; this is the one that counts, because a hand-written request
      // never sees the form at all.
      if (!meetsMinimumAge(dateOfBirth)) {
        throw new ApiError(
          403,
          `You must be at least ${MINIMUM_AGE_YEARS} to use Flouna`,
        );
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing?.emailVerified) {
        throw new ApiError(409, "An account with this email already exists");
      }

      const passwordHash = await hashPassword(password);
      // Phone is unique — if someone else already claimed it, keep the signup
      // working rather than failing on an optional field.
      const phoneFree =
        phone && !(await prisma.user.findFirst({ where: { phone, NOT: { email } } }));
      const optional = {
        ...(phoneFree ? { phone } : {}),
      };
      // Written with the account rather than after it. An account that exists
      // without a recorded lawful basis is data we are holding and cannot
      // account for, which is the thing DPDP s.6 is about.
      const consent = {
        termsAcceptedAt: new Date(),
        termsVersion: POLICY_VERSION,
      };
      const updateExisting = (id: string) =>
        prisma.user.update({
          where: { id },
          data: { name, passwordHash, dateOfBirth, ...consent, ...optional },
        });
      const user = existing
        ? await updateExisting(existing.id)
        : await prisma.user
            .create({
              data: { name, email, passwordHash, dateOfBirth, ...consent, ...optional },
            })
            .catch(async (err: { code?: string }) => {
              // A second tap created the same account a moment earlier: both
              // looked, both found nothing, both tried to create it. This one
              // carries on as the update it would have been, rather than
              // failing a sign up that worked with a 500.
              if (err?.code !== "P2002") throw err;
              const raced = await prisma.user.findUnique({ where: { email } });
              if (!raced) throw err;
              if (raced.emailVerified) {
                throw new ApiError(409, "An account with this email already exists");
              }
              return updateExisting(raced.id);
            });

      // The account row carries the current state; the log carries the
      // history, including this being the second time if they signed up,
      // lapsed, and came back to a newer version of the terms.
      await recordConsent(user.id, "terms", true, {
        version: POLICY_VERSION,
        ctx: { ip: req.ip, userAgent: req.get("user-agent") },
      });

      const code = await createOtp({
        userId: user.id,
        channel: "email",
        target: email,
        purpose: "signup",
      });

      // The account is already created and the code already stored. A mail
      // failure past this point is not a server fault and must not be reported
      // as one: it was returning 500 after a twelve second SMTP timeout, which
      // told the person nothing, made them retry, and failed identically every
      // time — while their account sat there, created and unverifiable.
      //
      // The account is deliberately kept. It is what makes "resend code" work
      // the moment mail is delivering again, instead of stranding whoever
      // signed up during the outage.
      try {
        await sendOtpEmail(email, code);
      } catch (err) {
        console.error(
          "[auth] account created but the code could not be sent:",
          err instanceof Error ? err.message : String(err),
        );
        throw new ApiError(
          502,
          "Your account was created, but we could not send the verification code just now. Try again in a few minutes.",
          "otp_delivery_failed",
        );
      }

      res.status(201).json({ ok: true, next: "verify-email" });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  "/verify-email",
  sensitiveLimit,
  validateBody(
    z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { email, code } = req.body as { email: string; code: string };
      const ok = await consumeOtp({ target: email, purpose: "signup", code });
      if (!ok) throw new ApiError(400, "Invalid or expired code");

      const user = await prisma.user.update({
        where: { email },
        data: { emailVerified: true },
      });
      // Best-effort — never blocks or fails the verification response.
      void sendWelcomeEmail(user.email, user.name ?? "");
      await startSession(res, user.id);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  "/resend-otp",
  sensitiveLimit,
  validateBody(z.object({ email: emailSchema }).strict()),
  async (req, res, next) => {
    try {
      const { email } = req.body as { email: string };
      const user = await prisma.user.findUnique({ where: { email } });
      // Don't reveal whether the email exists — respond identically either way.
      if (user && !user.emailVerified) {
        const code = await createOtp({
          userId: user.id,
          channel: "email",
          target: email,
          purpose: "signup",
        });
        await sendOtpEmail(email, code);
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- login ----------

// After this many consecutive failures, the account is locked for a window.
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60_000;

/**
 * Counts a wrong password, and locks the account at the limit.
 *
 * Incremented by the database rather than written back as the value read
 * with the user plus one. Wrong passwords sent at the same moment all wrote
 * the same number, so a burst of ten counted as one and the lock never
 * engaged. Shared by the customer and operator logins so the two cannot
 * drift apart again; the operator one had the same fault.
 */
async function recordFailedLogin(userId: string) {
  const { failedLogins } = await prisma.user.update({
    where: { id: userId },
    data: { failedLogins: { increment: 1 } },
    select: { failedLogins: true },
  });
  if (failedLogins >= MAX_FAILED_LOGINS) {
    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_MS) },
    });
  }
}

authRouter.post(
  "/login",
  sensitiveLimit,
  validateBody(z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict()),
  async (req, res, next) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const user = await prisma.user.findUnique({ where: { email } });

      // Account-level lockout (M3): blocks slow distributed grinding that a
      // per-IP limit alone wouldn't catch. Generic message — no enumeration.
      if (user?.lockedUntil && user.lockedUntil > new Date()) {
        throw new ApiError(429, "Too many attempts. Try again later.");
      }

      // Single generic error for all failure modes — no account enumeration.
      if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
        if (user) await recordFailedLogin(user.id);
        throw new ApiError(401, "Incorrect email or password");
      }

      // Successful auth — clear any failure counter / lock.
      if (user.failedLogins > 0 || user.lockedUntil) {
        // A login that succeeds right after failed attempts is worth flagging:
        // it's the shape of a guessed/leaked password finally getting in.
        if (user.failedLogins >= 2) {
          await enqueueNotification(user.id, "security.suspicious_login", {
            attempts: String(user.failedLogins),
          }).catch(() => {});
        }
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLogins: 0, lockedUntil: null },
        });
      }

      if (!user.emailVerified) {
        const code = await createOtp({
          userId: user.id,
          channel: "email",
          target: email,
          purpose: "signup",
        });
        await sendOtpEmail(email, code);
        return res.status(403).json({ error: "Email not verified", next: "verify-email" });
      }

      // Two-factor: the password was right, but it isn't enough on its own for
      // this account. No session is issued here — the code has to come back
      // through /login/verify first.
      if (user.twoFactorEnabled) {
        // Its own purpose, not the console's "step_up": a code minted for one
        // must never be spendable on the other, even though both are six digits
        // to the same mailbox.
        const code = await createOtp({
          userId: user.id,
          channel: "email",
          target: email,
          purpose: "login_2fa",
        });
        await sendOtpEmail(email, code, "login_2fa");
        return res.json({ next: "two-factor" });
      }

      await startSession(res, user.id, false, req);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

// Second step of a two-factor login: the emailed code. Rate limited like the
// password step, since this is the other half of the same gate.
authRouter.post(
  "/login/verify",
  sensitiveLimit,
  validateBody(
    z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { email, code } = req.body as { email: string; code: string };
      const user = await prisma.user.findUnique({ where: { email } });
      // Re-check at verify time: the factor could have been turned off between
      // the two steps, and a code must never start a session for an account
      // that never asked for one.
      if (!user?.twoFactorEnabled) throw new ApiError(401, "Invalid or expired code");

      const ok = await consumeOtp({ target: email, purpose: "login_2fa", code });
      if (!ok) throw new ApiError(401, "Invalid or expired code");

      await startSession(res, user.id, false, req);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- login activity (one device at a time) ----------
//
// Both live here rather than with the other user endpoints for the same reason
// revoke-others does: the refresh cookie is scoped to /api/auth, so this is the
// only place that can tell which session belongs to the caller.

authRouter.get("/sessions/current", requireAuth, async (req, res, next) => {
  try {
    const raw = req.cookies?.refresh_token as string | undefined;
    if (!raw) return res.json({ currentId: null });
    const row = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: { id: true, userId: true },
    });
    res.json({ currentId: row && row.userId === req.userId! ? row.id : null });
  } catch (err) {
    next(err);
  }
});

authRouter.delete("/sessions/:id", sessionLimiter, requireAuth, async (req, res, next) => {
  try {
    const token = await prisma.refreshToken.findFirst({
      where: { id: req.params.id, userId: req.userId!, revokedAt: null },
      select: { id: true, tokenHash: true },
    });
    if (!token) throw new ApiError(404, "Session not found");

    const raw = req.cookies?.refresh_token as string | undefined;
    if (raw && hashToken(raw) === token.tokenHash) {
      throw new ApiError(409, "That's this device, use log out instead");
    }

    await prisma.refreshToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- operator console login (password + email OTP step-up) ----------
//
// Two-factor gate for the back-office. Step 1 verifies the password; if the
// account is an operator we DON'T issue a session — we email a one-time code and
// ask for it. Step 2 verifies that code and only then starts a step-up-marked
// session that the console routes require. Ordinary users get the same flat 404
// the rest of the console surface returns, so this doesn't reveal who's an
// operator. A leaked operator password alone never reaches the back-office.

authRouter.post(
  "/console/login",
  sensitiveLimit,
  validateBody(z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict()),
  async (req, res, next) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const user = await prisma.user.findUnique({ where: { email } });

      if (user?.lockedUntil && user.lockedUntil > new Date()) {
        throw new ApiError(429, "Too many attempts. Try again later.");
      }

      // Password check first (generic error — no enumeration).
      const passwordOk =
        user?.passwordHash && (await verifyPassword(password, user.passwordHash));
      if (!user || !passwordOk) {
        if (user) await recordFailedLogin(user.id);
        throw new ApiError(401, "Incorrect email or password");
      }

      // Valid credentials, but NOT an operator → hide that the console exists.
      if (!isOperator(normalizeRole(user.role))) {
        throw new ApiError(404, "Not found");
      }

      // Clear any failure counter on a good password.
      if (user.failedLogins > 0 || user.lockedUntil) {
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLogins: 0, lockedUntil: null },
        });
      }

      // Send the second factor. We do NOT start a session yet.
      const code = await createOtp({
        userId: user.id,
        channel: "email",
        target: email,
        purpose: "step_up",
      });
      await sendOtpEmail(email, code, "step_up");
      res.json({ next: "otp" });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  "/console/verify",
  sensitiveLimit,
  validateBody(
    z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { email, code } = req.body as { email: string; code: string };
      const user = await prisma.user.findUnique({ where: { email } });
      // Re-confirm operator status at verify time (role could have changed).
      if (!user || !isOperator(normalizeRole(user.role))) {
        throw new ApiError(404, "Not found");
      }
      if (user.suspendedAt) throw new ApiError(403, "Account suspended");

      const ok = await consumeOtp({ target: email, purpose: "step_up", code });
      if (!ok) throw new ApiError(401, "Invalid or expired code");

      // OTP cleared → start a step-up-verified session.
      await startSession(res, user.id, true);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- Google sign-in ----------

authRouter.post(
  "/google",
  sensitiveLimit,
  validateBody(z.object({ credential: z.string().min(10) }).strict()),
  async (req, res, next) => {
    try {
      const { credential } = req.body as { credential: string };
      // Local convenience sign-in, behind two independent locks. NODE_ENV
      // alone isn't enough: it *defaults* to "development", so a deployment
      // that forgets to set it would silently accept this fixed string as a
      // valid session — and would skip the production boot checks at the same
      // time. Also requiring Google to be unconfigured mirrors the client
      // (which only renders this button when there's no client ID) and fails
      // closed on any real deployment, where the key is always set.
      const devMockAllowed =
        env.NODE_ENV === "development" && !env.GOOGLE_CLIENT_ID;
      if (devMockAllowed && credential === "dev-mock-google") {
        const email = "dev@flouna.local";
        let user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
          user = await prisma.user.create({
            data: {
              email,
              name: "Local Developer",
              googleId: "dev-mock-google-id",
              emailVerified: true,
            },
          });
        }
        await startSession(res, user.id);
        return res.json({ user: publicUser(user) });
      }
      if (!googleClient || !env.GOOGLE_CLIENT_ID) {
        throw new ApiError(503, "Google sign-in is not configured");
      }
      // A token that does not verify is the caller's problem or a
      // misconfiguration, never an internal fault — but verifyIdToken throws,
      // and nothing caught it. Every rejected token therefore reached the user
      // as "Internal server error" and was written to monitoring as a crash.
      //
      // The most common cause is not a bad token at all: it is the browser
      // being given one client ID and the server verifying against another, so
      // Google refuses the audience. That is a five-minute fix once somebody is
      // told, and unreadable when the only symptom is a 500.
      let ticket;
      try {
        ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: env.GOOGLE_CLIENT_ID,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Logged in full for whoever is on call; the reply stays short.
        console.error("[auth] Google token rejected:", reason);
        const wrongAudience = /audience|recipient|aud/i.test(reason);
        throw new ApiError(
          401,
          wrongAudience
            ? "Google sign-in is not set up correctly for this site. Check that the browser and the server are using the same Google client ID."
            : "Google sign-in failed. Please try again, or use email instead.",
        );
      }
      const payload = ticket.getPayload();
      if (!payload?.email || !payload.sub) {
        throw new ApiError(401, "Google sign-in failed");
      }

      const email = payload.email.toLowerCase();
      let user = await prisma.user.findFirst({
        where: { OR: [{ googleId: payload.sub }, { email }] },
      });
      if (!user) {
        user = await prisma.user.create({
          data: {
            email,
            name: payload.name ?? email.split("@")[0] ?? "User",
            googleId: payload.sub,
            emailVerified: true,
            avatarUrl: payload.picture ?? null,
          },
        });
      } else if (!user.googleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { googleId: payload.sub, emailVerified: true },
        });
      }

      await startSession(res, user.id);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- forgot / reset password ----------

authRouter.post(
  "/forgot",
  sensitiveLimit,
  validateBody(z.object({ email: emailSchema }).strict()),
  async (req, res, next) => {
    try {
      const { email } = req.body as { email: string };
      const user = await prisma.user.findUnique({ where: { email } });
      // Identical response whether or not the account exists.
      if (user) {
        const code = await createOtp({
          userId: user.id,
          channel: "email",
          target: email,
          purpose: "reset",
        });
        // A mail outage is not a server fault and must not be reported as one.
        // This was answering a blocked SMTP port with "Internal server error",
        // which reads as "the site is broken" to the one person who most needs
        // to be told to try again shortly — and it is the very screen someone
        // locked out of their account lands on. The code is already stored, so
        // a retry once mail is delivering again works without re-issuing it.
        await sendOtpEmail(email, code, "reset").catch((err: unknown) => {
          console.error(
            "[auth] reset code could not be sent:",
            err instanceof Error ? err.message : String(err),
          );
          throw new ApiError(
            502,
            "We could not send the code just now. Try again in a few minutes.",
            "otp_delivery_failed",
          );
        });
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  "/reset",
  sensitiveLimit,
  validateBody(
    z.object({
      email: emailSchema,
      code: z.string().regex(/^\d{6}$/),
      password: passwordSchema,
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { email, code, password } = req.body as {
        email: string;
        code: string;
        password: string;
      };
      const ok = await consumeOtp({ target: email, purpose: "reset", code });
      if (!ok) throw new ApiError(400, "Invalid or expired code");

      const user = await prisma.user.update({
        where: { email },
        data: {
          passwordHash: await hashPassword(password),
          emailVerified: true,
          failedLogins: 0,
          lockedUntil: null, // a successful reset clears any lockout
        },
      });
      // Changing the password signs out every other device.
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Security alert — one cheap insert, but never fails the reset.
      await enqueueNotification(user.id, "security.password_changed").catch(
        () => {},
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- phone OTP (scaffolded — SMS provider integrated later) ----------

authRouter.post("/phone/send-otp", sensitiveLimit, (_req, res) => {
  res.status(501).json({ error: "Phone OTP is coming soon" });
});

// ---------- session lifecycle ----------

authRouter.post("/refresh", sessionLimiter, async (req, res, next) => {
  try {
    const raw = req.cookies?.refresh_token as string | undefined;
    if (!raw) throw new ApiError(401, "Not authenticated");
    const rotated = await rotateRefreshToken(raw);
    if (!rotated) {
      clearAuthCookies(res);
      throw new ApiError(401, "Session expired");
    }
    // Re-read the role on refresh so a promotion/demotion propagates into the
    // new access token (and a suspended operator can be cut off here too).
    const user = await prisma.user.findUnique({
      where: { id: rotated.userId },
      select: { role: true, suspendedAt: true },
    });
    if (user?.suspendedAt) {
      clearAuthCookies(res);
      throw new ApiError(403, "Account suspended");
    }
    setAuthCookies(
      res,
      signAccessToken(rotated.userId, normalizeRole(user?.role), rotated.stepUp),
      rotated.token,
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", sessionLimiter, async (req, res) => {
  const raw = req.cookies?.refresh_token as string | undefined;
  if (raw) await revokeRefreshToken(raw);
  clearAuthCookies(res);
  res.json({ ok: true });
});

// Sign out everywhere except this device.
//
// Lives on the auth router, not with the other user endpoints, because the
// refresh cookie is deliberately scoped to /api/auth for CSRF defence — from
// anywhere else the cookie simply isn't sent, and the handler would have no way
// to tell which session is the caller's. Kept as revoke-others rather than
// revoke-all: a control that also drops the current session just reads as a
// crash to whoever pressed it.
authRouter.post(
  "/sessions/revoke-others",
  sessionLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const raw = req.cookies?.refresh_token as string | undefined;
      if (!raw) throw new ApiError(401, "Not authenticated");
      const { count } = await prisma.refreshToken.updateMany({
        where: {
          userId: req.userId!,
          revokedAt: null,
          NOT: { tokenHash: hashToken(raw) },
        },
        data: { revokedAt: new Date() },
      });
      res.json({ revoked: count });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) throw new ApiError(401, "Not authenticated");
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});
