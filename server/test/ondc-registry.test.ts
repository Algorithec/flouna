import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

// What the ONDC registry does to a new subscriber, played from the registry's
// side: fetch the verification page and check its signature with the public
// key we registered, then send a challenge encrypted to our encryption key and
// expect the plaintext back. If either fails the subscription never completes,
// and nothing on our side would look wrong.

const signing = crypto.generateKeyPairSync("ed25519");
const otherEnc = crypto.generateKeyPairSync("x25519");
const ourEnc = crypto.generateKeyPairSync("x25519");
const registryEnc = crypto.generateKeyPairSync("x25519");
const REQUEST_ID = "flouna-test-request-id";

// The portal's key file shape: libsodium's 64-byte signing key (seed + public).
const seed = signing.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
const pubRaw = signing.publicKey.export({ type: "spki", format: "der" }).subarray(-32);

let app: import("express").Express;

beforeAll(async () => {
  process.env.ONDC_SIGNING_PRIVATE_KEY = Buffer.concat([seed, pubRaw]).toString("base64");
  // Two subscriptions, two keys; the one the challenge uses is listed second.
  process.env.ONDC_ENCRYPTION_PRIVATE_KEY = [otherEnc, ourEnc]
    .map((k) => k.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"))
    .join(",");
  process.env.ONDC_SITE_REQUEST_ID = REQUEST_ID;
  process.env.ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY = registryEnc.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const { createApp } = await import("../src/app.js");
  const { env } = await import("../src/config/env.js");
  Object.assign(env, {
    ONDC_SIGNING_PRIVATE_KEY: process.env.ONDC_SIGNING_PRIVATE_KEY,
    ONDC_ENCRYPTION_PRIVATE_KEY: process.env.ONDC_ENCRYPTION_PRIVATE_KEY,
    ONDC_SITE_REQUEST_ID: REQUEST_ID,
  });
  app = createApp();
});

describe("ONDC registry checks on ondc.flouna.com", () => {
  it("serves a verification page whose signature checks out with our public key", async () => {
    const res = await request(app).get("/ondc-site-verification.html").expect(200);
    const sig = /content='([^']+)'/.exec(res.text)?.[1];
    expect(sig).toBeTruthy();
    expect(crypto.verify(null, Buffer.from(REQUEST_ID), signing.publicKey, Buffer.from(sig!, "base64"))).toBe(true);
  });

  it("answers the on_subscribe challenge with the plaintext", async () => {
    const plain = "registry-challenge-" + crypto.randomUUID();
    const shared = crypto.diffieHellman({ privateKey: registryEnc.privateKey, publicKey: ourEnc.publicKey });
    const cipher = crypto.createCipheriv("aes-256-ecb", shared, null);
    const challenge = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");

    const res = await request(app)
      .post("/ondc/on_subscribe")
      .send({ subscriber_id: "ondc.flouna.com", challenge })
      .expect(200);
    expect(res.body).toEqual({ answer: plain });
  });

  it("refuses a challenge it cannot decrypt instead of failing as a server fault", async () => {
    await request(app)
      .post("/ondc/on_subscribe")
      .send({ subscriber_id: "ondc.flouna.com", challenge: Buffer.from("not ours").toString("base64") })
      .expect(400);
  });
});
