import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../../config/env.js";

// The two things the ONDC registry asks of a subscriber's own domain, before
// any order flows: proof that we control it, and proof that we hold the
// encryption key we registered.
//
// Served from the root of ondc.flouna.com, not under /api, because the
// registry builds both URLs from the subscriber id itself:
//   https://<subscriber_id>/ondc-site-verification.html
//   https://<subscriber_id>/ondc/on_subscribe
//
// The keys come from the file the ONDC portal issues at subscription and live
// only in Railway's environment. Without them these routes answer 404 rather
// than serve something that would fail verification in a way that looks like
// our bug.

// Published by ONDC in developer-docs/registry/Onboarding of Participants.md.
const REGISTRY_ENCRYPTION_PUBLIC_KEY = {
  preprod: "MCowBQYDK2VuAyEARa/WcMCzNQp4DWjvTI4DK7vHL6EdaHqN4GjFIu9wxxM=",
  prod: "MCowBQYDK2VuAyEAwASk2D4O3p/tuD8f9sNQAQlwOU2w3DAumcOK9qHCFwI=",
} as const;

// DER prefixes that turn raw 32-byte keys into what node:crypto accepts.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/**
 * The portal's signing key is libsodium's 64-byte form (seed then public key)
 * in base64. A bare 32-byte seed is accepted too, so a key generated with
 * node:crypto works the same way.
 */
export function signingKeyFrom(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, "base64");
  const seed = raw.length === 64 ? raw.subarray(0, 32) : raw;
  if (seed.length !== 32) throw new Error("ONDC signing key is not a 32 or 64 byte Ed25519 key");
  return crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The portal issues PKCS#8 DER; a raw 32-byte key is accepted as well. */
export function encryptionKeyFrom(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, "base64");
  const der = raw.length === 32 ? Buffer.concat([X25519_PKCS8_PREFIX, raw]) : raw;
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/**
 * Decrypts the registry's challenge: AES-256-ECB under the X25519 shared
 * secret between our encryption key and the registry's, as ONDC's reference
 * implementation does it.
 */
export function answerChallenge(
  challenge: string,
  ourPrivate: crypto.KeyObject,
  registryPublicB64: string,
): string {
  const registryPublic = crypto.createPublicKey({
    key: Buffer.from(registryPublicB64, "base64"),
    format: "der",
    type: "spki",
  });
  const shared = crypto.diffieHellman({ privateKey: ourPrivate, publicKey: registryPublic });
  const decipher = crypto.createDecipheriv("aes-256-ecb", shared, null);
  return Buffer.concat([
    decipher.update(Buffer.from(challenge, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export const ondcRegistryRouter = Router();

ondcRegistryRouter.get("/ondc-site-verification.html", (_req, res) => {
  if (!env.ONDC_SIGNING_PRIVATE_KEY || !env.ONDC_SITE_REQUEST_ID) {
    res.status(404).send("Not configured");
    return;
  }
  const signed = crypto
    .sign(null, Buffer.from(env.ONDC_SITE_REQUEST_ID), signingKeyFrom(env.ONDC_SIGNING_PRIVATE_KEY))
    .toString("base64");
  res
    .type("html")
    .send(
      `<html>\n  <head>\n    <meta name='ondc-site-verification' content='${signed}' />\n  </head>\n  <body>\n    ONDC Site Verification Page\n  </body>\n</html>\n`,
    );
});

ondcRegistryRouter.post("/ondc/on_subscribe", (req, res) => {
  const challenge = (req.body as { challenge?: unknown } | undefined)?.challenge;
  if (!env.ONDC_ENCRYPTION_PRIVATE_KEY) {
    res.status(404).json({ error: "Not configured" });
    return;
  }
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > 2048) {
    res.status(400).json({ error: "Missing challenge" });
    return;
  }
  // One key per subscription. The portal issues a fresh pair for every
  // domain subscribed under ondc.flouna.com, and the challenge is encrypted to
  // whichever one the registry is checking, so each is tried in turn. A wrong
  // key fails AES padding rather than producing a plausible answer.
  const registryPublic =
    process.env.ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY ??
    REGISTRY_ENCRYPTION_PUBLIC_KEY[env.ONDC_REGISTRY_ENV];
  for (const key of env.ONDC_ENCRYPTION_PRIVATE_KEY.split(",").map((k) => k.trim()).filter(Boolean)) {
    try {
      res.json({ answer: answerChallenge(challenge, encryptionKeyFrom(key), registryPublic) });
      return;
    } catch {
      // Not this subscription's key; try the next.
    }
  }
  // None of our keys decrypts it: the registry's record and ours disagree.
  // Say so plainly rather than as a server fault.
  res.status(400).json({ error: "Could not decrypt the challenge" });
});
