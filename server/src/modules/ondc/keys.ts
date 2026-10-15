import crypto from "node:crypto";

// Key handling shared by everything ONDC: the registry handshake and request
// signing. Kept free of app configuration so the cryptography can be used,
// and tested, without a database or secrets in the environment.

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
  const plain = Buffer.concat([decipher.update(Buffer.from(challenge, "base64")), decipher.final()]);
  // Padding alone is not proof of the right key: about one wrong key in 256
  // produces output that happens to end in valid padding. The registry's
  // challenge is printable text, and garbage from a wrong key essentially
  // never is, so that is checked too.
  if (plain.length === 0 || !plain.every((b) => b >= 0x20 && b <= 0x7e)) {
    throw new Error("Challenge did not decrypt to text under this key");
  }
  return plain.toString("utf8");
}
