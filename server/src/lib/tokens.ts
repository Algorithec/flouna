import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Response } from "express";
import { env, isProd } from "../config/env.js";
import { prisma } from "./prisma.js";
import type { Role } from "./rbac.js";

// `step` marks a session that has cleared operator step-up (2FA). Ordinary user
// sessions never set it; console routes require it so a leaked operator password
// alone — without the email OTP — cannot reach the back-office.
export type AccessPayload = { sub: string; role: Role; step?: boolean };

// One algorithm, named on both sides. Left to the library, verify accepts any
// HMAC algorithm the header asks for, so the header, which the client sends,
// would be choosing how its own signature is checked.
const ALGORITHM = "HS256" as const;

export function signAccessToken(
  userId: string,
  role: Role = "user",
  stepUp = false,
) {
  return jwt.sign(
    { sub: userId, role, ...(stepUp ? { step: true } : {}) } satisfies AccessPayload,
    env.JWT_ACCESS_SECRET,
    {
      algorithm: ALGORITHM,
      expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
    },
  );
}

export function verifyAccessToken(token: string): AccessPayload | null {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [ALGORITHM] }) as AccessPayload;
  } catch {
    return null;
  }
}

// Refresh tokens are opaque random strings stored hashed — a DB leak
// exposes nothing usable, and individual sessions can be revoked.

/** Hash a raw refresh token the way it is stored, so callers can match a row. */
export function hashToken(raw: string) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function issueRefreshToken(
  userId: string,
  stepUp = false,
  /** Device details for Login Activity; carried forward on rotation. */
  device?: { userAgent?: string | null; ip?: string | null },
) {
  const raw = crypto.randomBytes(48).toString("hex");
  const tokenHash = hashToken(raw);
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      stepUp,
      userAgent: device?.userAgent ?? null,
      ip: device?.ip ?? null,
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    },
  });
  return raw;
}

export async function rotateRefreshToken(raw: string) {
  const tokenHash = hashToken(raw);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
    return null;
  }
  // Claim the token before replacing it. The revoke used to be unconditional,
  // so two requests presenting the same refresh token both read it as live,
  // both revoked it and both were issued a new one: one token became two
  // independent sessions, and a captured token racing the real client got a
  // durable session of its own out of a single use. Scoped to revokedAt being
  // null, only one of them wins and the loser is told the session is over.
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: existing.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (claimed.count === 0) return null;
  // Carry the step-up status and the device details onto the rotated token, so
  // a verified operator session keeps its 2FA standing and Login Activity keeps
  // naming the device instead of resetting to "Unknown" every fifteen minutes.
  const next = await issueRefreshToken(existing.userId, existing.stepUp, {
    userAgent: existing.userAgent,
    ip: existing.ip,
  });
  return { userId: existing.userId, token: next, stepUp: existing.stepUp };
}

export async function revokeRefreshToken(raw: string) {
  const tokenHash = hashToken(raw);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  const base = {
    httpOnly: true,
    secure: isProd,
  };
  // Access token: lax so top-level navigation carries it.
  res.cookie("access_token", accessToken, {
    ...base,
    sameSite: "lax" as const,
    maxAge: 15 * 60_000,
  });
  // Refresh token: strict + scoped to /api/auth — it's only ever sent to the
  // refresh/logout endpoints, so the tighter policy adds CSRF defense for free.
  res.cookie("refresh_token", refreshToken, {
    ...base,
    sameSite: "strict" as const,
    path: "/api/auth",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie("access_token");
  res.clearCookie("refresh_token", { path: "/api/auth" });
}

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}
