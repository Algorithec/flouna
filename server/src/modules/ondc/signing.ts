import crypto from "node:crypto";
import { signingKeyFrom } from "./keys.js";

// ONDC request signing and verification.
//
// Every message on the network carries an Authorization header proving which
// participant sent it and that the body was not altered. The format is fixed
// by ONDC and unforgiving: one space out of place and every signature fails,
// with nothing in the error to say why. The signing string below is the one
// that verifies ONDC's own published example (see the test), not a reading of
// the prose, which is inconsistent about the spacing.

export const SIGNATURE_TTL_SECONDS = 3600;

/** BLAKE2b-512 of the exact bytes sent, base64. */
export function digestOf(body: string | Buffer): string {
  return crypto.createHash("blake2b512").update(body).digest("base64");
}

export function signingString(created: number, expires: number, digest: string): string {
  return `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`;
}

export type SigningIdentity = {
  subscriberId: string;
  uniqueKeyId: string;
  /** Ed25519, as the portal's key file holds it (64-byte libsodium or 32-byte seed), base64. */
  signingPrivateKey: string;
};

export function createAuthorizationHeader(
  body: string | Buffer,
  id: SigningIdentity,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const created = now;
  const expires = now + SIGNATURE_TTL_SECONDS;
  const signature = crypto
    .sign(null, Buffer.from(signingString(created, expires, digestOf(body))), signingKeyFrom(id.signingPrivateKey))
    .toString("base64");
  return (
    `Signature keyId="${id.subscriberId}|${id.uniqueKeyId}|ed25519",algorithm="ed25519",` +
    `created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${signature}"`
  );
}

export type ParsedAuthorization = {
  subscriberId: string;
  uniqueKeyId: string;
  algorithm: string;
  keyIdAlgorithm: string;
  created: number;
  expires: number;
  signature: string;
};

export function parseAuthorizationHeader(header: string): ParsedAuthorization | null {
  const fields: Record<string, string> = {};
  for (const m of header.replace(/^Signature\s+/i, "").matchAll(/(\w+)="([^"]*)"/g)) {
    fields[m[1]!] = m[2]!;
  }
  const parts = (fields.keyId ?? "").split("|");
  const created = Number(fields.created);
  const expires = Number(fields.expires);
  if (parts.length !== 3 || !fields.signature || !Number.isInteger(created) || !Number.isInteger(expires)) {
    return null;
  }
  return {
    subscriberId: parts[0]!,
    uniqueKeyId: parts[1]!,
    keyIdAlgorithm: parts[2]!,
    algorithm: fields.algorithm ?? "",
    created,
    expires,
    signature: fields.signature,
  };
}

export type VerifyResult =
  | { ok: true; subscriberId: string; uniqueKeyId: string }
  | { ok: false; reason: "malformed" | "algorithm" | "not_yet_valid" | "expired" | "unknown_key" | "bad_signature" };

/** Allowance for clocks that disagree by a little. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Checks a header against the exact body received.
 *
 * `lookupPublicKey` returns the sender's registered Ed25519 public key
 * (raw 32 bytes, base64) for a subscriber id and key id, or null. Fails closed:
 * anything unreadable, unknown, outside its window or not matching is refused.
 */
export async function verifyAuthorizationHeader(
  header: string | undefined,
  body: string | Buffer,
  lookupPublicKey: (subscriberId: string, uniqueKeyId: string) => Promise<string | null>,
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const parsed = header ? parseAuthorizationHeader(header) : null;
  if (!parsed) return { ok: false, reason: "malformed" };
  if (parsed.algorithm !== "ed25519" || parsed.keyIdAlgorithm !== "ed25519") {
    return { ok: false, reason: "algorithm" };
  }
  if (parsed.created > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid" };
  if (parsed.expires < now - CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
  // The sender picks its own expiry. Without an age limit, a message signed
  // with a far off one could be replayed long after we stopped remembering
  // it. Nobody honest signs a message and sends it more than an hour later.
  if (parsed.created < now - SIGNATURE_TTL_SECONDS - CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };

  const publicKeyB64 = await lookupPublicKey(parsed.subscriberId, parsed.uniqueKeyId);
  if (!publicKeyB64) return { ok: false, reason: "unknown_key" };
  // A registry entry that is not a 32 byte Ed25519 key is treated as no key.
  // Letting it throw would leave the caller to turn a bad registry record into
  // a server fault.
  const rawKey = Buffer.from(publicKeyB64, "base64");
  if (rawKey.length !== 32) return { ok: false, reason: "unknown_key" };
  let valid: boolean;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
      format: "der",
      type: "spki",
    });
    valid = crypto.verify(
      null,
      Buffer.from(signingString(parsed.created, parsed.expires, digestOf(body))),
      publicKey,
      Buffer.from(parsed.signature, "base64"),
    );
  } catch {
    return { ok: false, reason: "unknown_key" };
  }
  return valid
    ? { ok: true, subscriberId: parsed.subscriberId, uniqueKeyId: parsed.uniqueKeyId }
    : { ok: false, reason: "bad_signature" };
}
