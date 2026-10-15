import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/modules/ondc/context.js";
import { createAuthorizationHeader, verifyAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter, type CallbackDeps, type ReceivedCallback } from "../src/modules/ondc/callbacks.routes.js";
import { createRegistryClient } from "../src/modules/ondc/registryClient.js";
import { answerChallenge, encryptionKeyFrom } from "../src/modules/ondc/keys.js";
import { buildSearch } from "../src/modules/ondc/retail.js";
import { app as fullApp } from "./helpers.js";

// Findings from a line by line review of the ONDC integration. Each test is
// written as the attack or the failure, and each one failed against the code
// before its fix.

function keypair() {
  const kp = crypto.generateKeyPairSync("ed25519");
  return {
    priv: kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
    pub: kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
  };
}
const realSeller = keypair();
const otherParticipant = keypair();
const KEYS: Record<string, string> = {
  "seller.test|s1": realSeller.pub,
  "intruder.test|x1": otherParticipant.pub,
};

function testApp(recorded: ReceivedCallback[], over: Partial<CallbackDeps> = {}) {
  const a = express();
  a.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  a.use(
    createCallbacksRouter({
      publicKeyFor: async (s, u) => KEYS[`${s}|${u}`] ?? null,
      record: async (cb) => {
        recorded.push(cb);
      },
      ...over,
    }),
  );
  return a;
}

function onConfirm(bppId: string, bapId = "ondc.flouna.com") {
  const ctx = buildContext({
    domain: "ONDC:RET11",
    action: "on_confirm",
    city: "std:080",
    transactionId: "t",
    bppId,
    bppUri: `https://${bppId}`,
  });
  return JSON.stringify({ context: { ...ctx, bap_id: bapId }, message: { order: { id: "o1", state: "Accepted" } } });
}

const sign = (body: string | Buffer, k: { priv: string }, sub: string, uk: string) =>
  createAuthorizationHeader(body, { subscriberId: sub, uniqueKeyId: uk, signingPrivateKey: k.priv });

const post = (a: express.Express, body: string, auth: string) =>
  request(a).post("/ondc/on_confirm").set("Content-Type", "application/json").set("Authorization", auth).send(body);

describe("ONDC review findings", () => {
  it("another registered participant cannot confirm an order in a seller's name", async () => {
    // intruder.test is a real participant with a valid registered key, signing
    // an on_confirm whose context says it comes from seller.test.
    const body = onConfirm("seller.test");
    const rec: ReceivedCallback[] = [];
    const res = await post(testApp(rec), body, sign(body, otherParticipant, "intruder.test", "x1"));
    expect(res.status).toBe(401);
    expect(rec).toHaveLength(0);
  });

  it("a message addressed to a different buyer app is refused", async () => {
    const body = onConfirm("seller.test", "some-other-bap.com");
    const rec: ReceivedCallback[] = [];
    const res = await post(testApp(rec), body, sign(body, realSeller, "seller.test", "s1"));
    expect(res.status).toBe(400);
    expect(rec).toHaveLength(0);
  });

  it("a registry key that is not a valid Ed25519 key gets a NACK, not a hung request", async () => {
    const body = onConfirm("seller.test");
    const res = await post(
      testApp([], { publicKeyFor: async () => "bm90LWEta2V5" }),
      body,
      sign(body, realSeller, "seller.test", "s1"),
    ).timeout(3000);
    expect(res.status).toBe(401);
    expect(res.body.message.ack.status).toBe("NACK");
  });

  it("the verifier refuses a registry key that is not a key, rather than throwing", async () => {
    const body = onConfirm("seller.test");
    const header = sign(body, realSeller, "seller.test", "s1");
    for (const bad of ["bm90LWEta2V5", Buffer.alloc(64, 1).toString("base64"), "!!!"]) {
      await expect(verifyAuthorizationHeader(header, body, async () => bad)).resolves.toEqual({
        ok: false,
        reason: "unknown_key",
      });
    }
  });

  it("a registry lookup that throws gets a NACK, not a hung request", async () => {
    const body = onConfirm("seller.test");
    const res = await post(
      testApp([], {
        publicKeyFor: async () => {
          throw new Error("boom");
        },
      }),
      body,
      sign(body, realSeller, "seller.test", "s1"),
    ).timeout(3000);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message.ack.status).toBe("NACK");
  });

  it("a message we failed to store is refused, so the seller sends it again", async () => {
    const body = onConfirm("seller.test");
    const res = await post(
      testApp([], {
        record: async () => {
          throw new Error("db down");
        },
      }),
      body,
      sign(body, realSeller, "seller.test", "s1"),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.message.ack.status).toBe("NACK");
  });

  it("the same message delivered twice is stored once and acknowledged both times", async () => {
    const body = onConfirm("seller.test");
    const rec: ReceivedCallback[] = [];
    const a = testApp(rec);
    const auth = sign(body, realSeller, "seller.test", "s1");
    for (let i = 0; i < 2; i++) {
      const res = await post(a, body, auth);
      expect(res.status).toBe(200);
      expect(res.body.message.ack.status).toBe("ACK");
    }
    expect(rec).toHaveLength(1);
  });

  it("a message that failed to store is stored when the seller retries it", async () => {
    const body = onConfirm("seller.test");
    const rec: ReceivedCallback[] = [];
    let failNext = true;
    const a = testApp(rec, {
      record: async (cb) => {
        if (failNext) {
          failNext = false;
          throw new Error("db blip");
        }
        rec.push(cb);
      },
    });
    const auth = sign(body, realSeller, "seller.test", "s1");
    expect((await post(a, body, auth)).status).toBeGreaterThanOrEqual(500);
    expect((await post(a, body, auth)).status).toBe(200);
    expect(rec).toHaveLength(1);
  });

  it("a seller's catalogue larger than 100 KB reaches the handler instead of being refused as too large", async () => {
    const big = JSON.stringify({ context: { action: "on_search" }, message: { catalog: { pad: "x".repeat(300_000) } } });
    const res = await request(fullApp).post("/ondc/on_search").set("Content-Type", "application/json").send(big);
    expect(res.status).not.toBe(413);
  });

  it("a registry that never answers does not hang verification", async () => {
    const client = createRegistryClient({
      registryUrl: "https://registry.test",
      identity: { subscriberId: "ondc.flouna.com", uniqueKeyId: "u", signingPrivateKey: keypair().priv },
      fetch: (_u, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      timeoutMs: 200,
    });
    const started = Date.now();
    expect(await client.publicKeyFor("seller.test", "s1")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  }, 5000);

  it("a flood of made up key ids cannot grow the key cache without bound", async () => {
    const client = createRegistryClient({
      registryUrl: "https://registry.test",
      identity: { subscriberId: "ondc.flouna.com", uniqueKeyId: "u", signingPrivateKey: keypair().priv },
      fetch: async () => ({ ok: true, status: 200, json: async () => [] }),
      maxCacheEntries: 50,
    });
    for (let i = 0; i < 500; i++) await client.publicKeyFor("seller.test", `junk-${i}`);
    expect(client.cacheSize()).toBeLessThanOrEqual(50);
  });

  it("the finder fee is stated exactly, not rounded to one decimal", () => {
    const m = buildSearch({ transactionId: "t", city: "std:080", finderFeePercent: 4.25 });
    const payment = m.message.intent.payment as Record<string, string>;
    expect(payment["@ondc/org/buyer_app_finder_fee_amount"]).toBe("4.25");
  });

  it("a wrong key whose output happens to pass AES padding is not taken as the answer", () => {
    // About 1 in 256 random decryptions end in valid padding. Find one made
    // with the wrong key and check it is still refused.
    const ours = crypto.generateKeyPairSync("x25519");
    const wrong = crypto.generateKeyPairSync("x25519");
    const registry = crypto.generateKeyPairSync("x25519");
    const regPub = registry.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const wrongKey = encryptionKeyFrom(wrong.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
    const shared = crypto.diffieHellman({ privateKey: registry.privateKey, publicKey: ours.publicKey });
    const wrongShared = crypto.diffieHellman({ privateKey: wrongKey, publicKey: registry.publicKey });
    let falsePositive: string | null = null;
    for (let i = 0; i < 5000 && !falsePositive; i++) {
      const c = crypto.createCipheriv("aes-256-ecb", shared, null);
      const challenge = Buffer.concat([c.update(crypto.randomUUID()), c.final()]).toString("base64");
      try {
        const d = crypto.createDecipheriv("aes-256-ecb", wrongShared, null);
        Buffer.concat([d.update(Buffer.from(challenge, "base64")), d.final()]);
        falsePositive = challenge;
      } catch {
        // Padding failed, as it usually does.
      }
    }
    expect(falsePositive).not.toBeNull();
    expect(() => answerChallenge(falsePositive!, wrongKey, regPub)).toThrow();
    // And the right key still answers.
    const ourKey = encryptionKeyFrom(ours.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
    const c = crypto.createCipheriv("aes-256-ecb", shared, null);
    const good = Buffer.concat([c.update("ondc-challenge-123"), c.final()]).toString("base64");
    expect(answerChallenge(good, ourKey, regPub)).toBe("ondc-challenge-123");
  });

  it("the signature is checked against the exact bytes received, not a re-encoding of them", async () => {
    // Bytes that are not valid UTF-8 change when decoded and re-encoded, so a
    // genuine signature over them fails if the router digests a string.
    const raw = Buffer.concat([
      Buffer.from('{"context":{"action":"on_confirm","bap_id":"ondc.flouna.com","bpp_id":"seller.test"},"x":"'),
      Buffer.from([0xc3]),
      Buffer.from('"}'),
    ]);
    const res = await request(testApp([]))
      .post("/ondc/on_confirm")
      .set("Content-Type", "application/json")
      .set("Authorization", sign(raw, realSeller, "seller.test", "s1"))
      // Sent as the bytes themselves, not serialised again by the client.
      .serialize((b: Buffer) => b as unknown as string)
      .send(raw);
    expect(res.body).toEqual({ message: { ack: { status: "ACK" } } });
    // And the low level check agrees.
    const header = sign(raw, realSeller, "seller.test", "s1");
    expect((await verifyAuthorizationHeader(header, raw, async () => realSeller.pub)).ok).toBe(true);
  });
});
