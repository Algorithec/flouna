import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { env } from "../../config/env.js";

const OTP_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_ACTIVE_SENDS = 3; // unexpired codes per target, blocks OTP spam

export async function createOtp(opts: {
  userId?: string;
  channel: "email" | "phone";
  target: string;
  purpose: "signup" | "login" | "reset" | "step_up" | "login_2fa" | "two_factor_setup";
}) {
  const active = await prisma.otpCode.count({
    where: {
      target: opts.target,
      purpose: opts.purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (active >= MAX_ACTIVE_SENDS) {
    throw new ApiError(429, "Too many codes requested. Try again in a few minutes.");
  }

  // crypto-random 6-digit code; never logged or stored in plain text
  const code = crypto.randomInt(100000, 1000000).toString();
  await prisma.otpCode.create({
    data: {
      userId: opts.userId,
      channel: opts.channel,
      target: opts.target,
      purpose: opts.purpose,
      codeHash: await bcrypt.hash(code, 10),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });
  return code;
}

export async function consumeOtp(opts: {
  target: string;
  purpose: "signup" | "login" | "reset" | "step_up" | "login_2fa" | "two_factor_setup";
  code: string;
}) {
  const candidates = await prisma.otpCode.findMany({
    where: {
      target: opts.target,
      purpose: opts.purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
      attempts: { lt: MAX_ATTEMPTS },
    },
    orderBy: { createdAt: "desc" },
  });

  const isDevFallback =
    env.NODE_ENV === "development" &&
    (!env.SMTP_HOST || !env.SMTP_PORT) &&
    opts.code === "123456";

  // Each guess claims one of the code's tries before it is checked, in a
  // single conditional write. The count used to be read, the guess checked,
  // and the count raised afterwards, so guesses sent at the same moment all
  // read "fewer than five" and were all checked: 30 together were 30 tries at
  // a code that allows five. On a password reset code that is a route to
  // taking over the account.
  for (const candidate of candidates) {
    const claimed = await prisma.otpCode.updateMany({
      where: {
        id: candidate.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    const ok = isDevFallback || (await bcrypt.compare(opts.code, candidate.codeHash));
    if (!ok) continue;

    // Consumed only if still unconsumed, so two requests with the right code
    // at the same moment cannot both succeed.
    const consumed = await prisma.otpCode.updateMany({
      where: { id: candidate.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 1) return true;
  }
  return false;
}
