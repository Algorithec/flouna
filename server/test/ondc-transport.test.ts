import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/modules/ondc/context.js";
import { sendSigned } from "../src/modules/ondc/transport.js";
import { createAuthorizationHeader, verifyAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter, type ReceivedCallback } from "../src/modules/ondc/callbacks.routes.js";

// The transport every ONDC flow rides on. The callback tests are written from
// the attacker's side: a seller app's answer is only believed when the
// signature on the exact bytes received belongs to the registered sender.

function keypair() {
  const kp = crypto.generateKeyPairSync("ed25519");
  return {
    priv: kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
    pub: kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
  };
}

describe("context", () => {
  it("uses the 1.2.0 shape for food and the 2.0.1 shape for rides", () => {
    const food = buildContext({ domain: "ONDC:RET11", action: "search", city: "std:080", transactionId: "t1" });
    expect(food).toMatchObject({ core_version: "1.2.0", country: "IND", city: "std:080", bap_id: "ondc.flouna.com" });
    expect(food).not.toHaveProperty("location");

    const ride = buildContext({ domain: "ONDC:TRV10", action: "search", city: "std:080", transactionId: "t2" });
    expect(ride).toMatchObject({ version: "2.0.1", location: { country: { code: "IND" }, city: { code: "std:080" } } });
    expect(ride).not.toHaveProperty("core_version");
  });
});

describe("sending", () => {
  const id = { subscriberId: "ondc.flouna.com", uniqueKeyId: "uk-1", signingPrivateKey: "" };
  const k = keypair();
  id.signingPrivateKey = k.priv;
  const envelope = { context: buildContext({ domain: "ONDC:RET11", action: "search", city: "std:080", transactionId: "t" }), message: {} };

  it("signs the exact body it sends, and reads an ACK", async () => {
    let seen: { url: string; body: string; auth: string } | null = null;
    const res = await sendSigned("https://gw.test/", "search", envelope, id, async (url, init) => {
      seen = { url, body: init.body, auth: init.headers.Authorization! };
      return { status: 200, text: async () => JSON.stringify({ message: { ack: { status: "ACK" } } }) };
    });
    expect(res).toEqual({ ack: true, status: 200 });
    expect(seen!.url).toBe("https://gw.test/search");
    const v = await verifyAuthorizationHeader(seen!.auth, seen!.body, async () => k.pub);
    expect(v.ok).toBe(true);
  });

  it("treats a NACK, a non-JSON answer and a dead network all as not accepted", async () => {
    const nack = await sendSigned("https://s.test", "select", envelope, id, async () => ({
      status: 200, text: async () => JSON.stringify({ message: { ack: { status: "NACK" } }, error: { code: "30000" } }),
    }));
    expect(nack).toMatchObject({ ack: false, status: 200, error: { code: "30000" } });
    const html = await sendSigned("https://s.test", "select", envelope, id, async () => ({ status: 200, text: async () => "<html>" }));
    expect(html.ack).toBe(false);
    const dead = await sendSigned("https://s.test", "select", envelope, id, async () => { throw new Error("ECONNREFUSED"); });
    expect(dead).toMatchObject({ ack: false, status: 0 });
  });
});

describe("receiving seller answers", () => {
  const seller = keypair();
  const gateway = keypair();
  const keys: Record<string, string> = { "seller.test|s1": seller.pub, "gw.test|g1": gateway.pub };

  function app(recorded: ReceivedCallback[], configured = true) {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; } }));
    a.use(createCallbacksRouter(configured ? {
      publicKeyFor: async (s, u) => keys[`${s}|${u}`] ?? null,
      record: async (cb) => { recorded.push(cb); },
    } : null));
    return a;
  }
  const body = JSON.stringify({
    context: buildContext({ domain: "ONDC:RET11", action: "on_search", city: "std:080", transactionId: "t9", bppId: "seller.test", bppUri: "https://seller.test" }),
    message: { catalog: { "bpp/providers": [] } },
  });
  const signedBy = (k: { priv: string }, sub: string, uk: string) =>
    createAuthorizationHeader(body, { subscriberId: sub, uniqueKeyId: uk, signingPrivateKey: k.priv });

  it("acknowledges and records a genuinely signed answer", async () => {
    const rec: ReceivedCallback[] = [];
    const res = await request(app(rec)).post("/ondc/on_search").set("Content-Type", "application/json")
      .set("Authorization", signedBy(seller, "seller.test", "s1")).send(body).expect(200);
    expect(res.body).toEqual({ message: { ack: { status: "ACK" } } });
    await new Promise((r) => setImmediate(r));
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ action: "on_search", senderId: "seller.test" });
  });

  it("refuses an answer whose body was changed after signing, and records nothing", async () => {
    const rec: ReceivedCallback[] = [];
    const forged = body.replace('"bpp/providers":[]', '"bpp/providers":[{"id":"fake"}]');
    const res = await request(app(rec)).post("/ondc/on_search").set("Content-Type", "application/json")
      .set("Authorization", signedBy(seller, "seller.test", "s1")).send(forged).expect(401);
    expect(res.body.message.ack.status).toBe("NACK");
    expect(rec).toHaveLength(0);
  });

  it("refuses an answer signed by someone claiming to be the seller", async () => {
    const impostor = keypair();
    await request(app([])).post("/ondc/on_search").set("Content-Type", "application/json")
      .set("Authorization", signedBy(impostor, "seller.test", "s1")).send(body).expect(401);
  });

  it("checks the gateway's signature too when the message was relayed", async () => {
    const good = signedBy(seller, "seller.test", "s1");
    await request(app([])).post("/ondc/on_search").set("Content-Type", "application/json")
      .set("Authorization", good).set("X-Gateway-Authorization", signedBy(gateway, "gw.test", "g1")).send(body).expect(200);
    await request(app([])).post("/ondc/on_search").set("Content-Type", "application/json")
      .set("Authorization", good).set("X-Gateway-Authorization", signedBy(keypair(), "gw.test", "g1")).send(body).expect(401);
  });

  it("refuses an answer posted to an endpoint its context does not name", async () => {
    await request(app([])).post("/ondc/on_confirm").set("Content-Type", "application/json")
      .set("Authorization", signedBy(seller, "seller.test", "s1")).send(body).expect(400);
  });

  it("says it is not configured rather than accept what it cannot verify", async () => {
    await request(app([], false)).post("/ondc/on_search").set("Content-Type", "application/json").send(body).expect(503);
  });
});
