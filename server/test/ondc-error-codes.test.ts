import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/modules/ondc/context.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter, type CallbackDeps } from "../src/modules/ondc/callbacks.routes.js";
import { app as fullApp } from "./helpers.js";

// Every refusal carries a code from ONDC's published list for buyer apps
// (developer-docs, protocol-network-extension/error-codes.md). The 1000x codes
// belong to the gateway; a buyer app answering with them tells the seller the
// wrong thing about what went wrong.

function keypair() {
  const kp = crypto.generateKeyPairSync("ed25519");
  return {
    priv: kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
    pub: kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
  };
}
const seller = keypair();

function appWith(over: Partial<CallbackDeps> = {}, configured = true) {
  const a = express();
  a.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  a.use(
    createCallbacksRouter(
      configured
        ? {
            publicKeyFor: async (s) => (s === "seller.test" ? seller.pub : null),
            record: async () => ({ duplicate: false }),
            ...over,
          }
        : null,
    ),
  );
  return a;
}

function body(over: Record<string, unknown> = {}) {
  const ctx = buildContext({
    domain: "ONDC:RET11",
    action: "on_confirm",
    city: "std:080",
    transactionId: "t",
    bppId: "seller.test",
    bppUri: "https://seller.test",
  });
  return JSON.stringify({ context: { ...ctx, ...over }, message: {} });
}
const sign = (b: string, created?: number, k = seller, sub = "seller.test") =>
  createAuthorizationHeader(b, { subscriberId: sub, uniqueKeyId: "s1", signingPrivateKey: k.priv }, created);

async function errorOf(a: express.Express, b: string, auth?: string) {
  const r = request(a).post("/ondc/on_confirm").set("Content-Type", "application/json");
  if (auth) r.set("Authorization", auth);
  const res = await r.send(b);
  expect(res.body.message.ack.status).toBe("NACK");
  return { status: res.status, ...res.body.error } as { status: number; type: string; code: string };
}

describe("ONDC error codes", () => {
  it("a signature that does not verify is 20001", async () => {
    const b = body();
    expect(await errorOf(appWith(), b, sign(b, undefined, keypair()))).toMatchObject({ code: "20001", status: 401 });
  });

  it("a signer that is not the seller named in the message is 20001", async () => {
    const b = body({ bpp_id: "someone-else.test" });
    expect(await errorOf(appWith(), b, sign(b))).toMatchObject({ code: "20001", status: 401 });
  });

  it("a message signed too long ago is a stale request, 20002", async () => {
    const b = body();
    const old = Math.floor(Date.now() / 1000) - 3 * 3600;
    expect(await errorOf(appWith(), b, sign(b, old))).toMatchObject({ code: "20002", status: 401 });
  });

  it("a message that does not meet the contract is 20006", async () => {
    const wrongAction = body({ action: "on_select" });
    expect(await errorOf(appWith(), wrongAction, sign(wrongAction))).toMatchObject({ code: "20006", status: 400 });
    const notOurs = body({ bap_id: "other.test" });
    expect(await errorOf(appWith(), notOurs, sign(notOurs))).toMatchObject({ code: "20006", status: 400 });
  });

  it("a failure on our side asks the seller to retry, 23001", async () => {
    const b = body();
    const failing = appWith({
      record: async () => {
        throw new Error("db down");
      },
    });
    expect(await errorOf(failing, b, sign(b))).toMatchObject({ code: "23001", status: 500 });
    expect(await errorOf(appWith({}, false), b, sign(b))).toMatchObject({ code: "23001", status: 503 });
  });

  it("an unsigned request refused before parsing is 20001", async () => {
    const res = await request(fullApp).post("/ondc/on_search").set("Content-Type", "application/json").send("{}");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("20001");
  });

  // The www.flouna.com subscriptions are registered with
  // https://www.flouna.com/api/ondc, which the web app proxies to /api/ondc.
  it("every callback answers under /api/ondc exactly as under /ondc", async () => {
    const { CALLBACK_ACTIONS } = await import("../src/modules/ondc/callbacks.routes.js");
    for (const a of CALLBACK_ACTIONS) {
      for (const prefix of ["/ondc", "/api/ondc"]) {
        const res = await request(fullApp).post(`${prefix}/${a}`).set("Content-Type", "application/json").send("{}");
        expect([prefix, a, res.status]).toEqual([prefix, a, 401]);
        expect(res.body.error.code).toBe("20001");
      }
    }
  });

  it("a signed callback under /api/ondc reaches the signature check", async () => {
    const b = body();
    const res = await request(fullApp).post("/api/ondc/on_confirm").set("Content-Type", "application/json").set("Authorization", sign(b)).send(b);
    expect(res.status).not.toBe(404);
    expect(res.body.message.ack.status).toBe("NACK");
  });

  it("the app's own /api/ondc routes are not taken for callbacks", async () => {
    const res = await request(fullApp).get("/api/ondc/mine");
    expect(res.status).toBe(401);
    expect(res.body.message).toBeUndefined();
  });

  it("no refusal anywhere uses a gateway code", async () => {
    const src = (await import("node:fs")).readFileSync;
    for (const f of ["src/modules/ondc/callbacks.routes.ts", "src/app.ts"]) {
      expect(src(f, "utf8")).not.toMatch(/"1000\d"/);
    }
  });
});
