import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BAP_ID, buildContext, subscriberIdProblem } from "../src/modules/ondc/context.js";
import { createAuthorizationHeader, verifyAuthorizationHeader, SIGNATURE_TTL_SECONDS } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter, type ReceivedCallback } from "../src/modules/ondc/callbacks.routes.js";
import { createRegistryClient, type Participant } from "../src/modules/ondc/registryClient.js";
import { sendSigned } from "../src/modules/ondc/transport.js";
import { buildConfirm, buildSelect, type Address } from "../src/modules/ondc/retail.js";
import { buildRideInit, buildRideSearch } from "../src/modules/ondc/mobility.js";
import { app as fullApp } from "./helpers.js";

// Second review pass over the ONDC integration. As before, each test was
// written as the failure and failed against the code before its fix.

function keypair() {
  const kp = crypto.generateKeyPairSync("ed25519");
  return {
    priv: kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
    pub: kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
  };
}
const seller = keypair();
const identity = { subscriberId: "ondc.flouna.com", uniqueKeyId: "u", signingPrivateKey: keypair().priv };

function testApp(record: (cb: ReceivedCallback) => Promise<void>) {
  const a = express();
  a.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  a.use(createCallbacksRouter({ publicKeyFor: async (s) => (s === "seller.test" ? seller.pub : null), record }));
  return a;
}

function envelope(action: string) {
  const ctx = buildContext({
    domain: "ONDC:RET11",
    action,
    city: "std:080",
    transactionId: "t",
    bppId: "seller.test",
    bppUri: "https://seller.test",
  });
  return JSON.stringify({ context: ctx, message: { issue: { id: "i1" } } });
}
const sign = (body: string, now?: number) =>
  createAuthorizationHeader(body, { subscriberId: "seller.test", uniqueKeyId: "s1", signingPrivateKey: seller.priv }, now);

const addr: Address = { name: "A", building: "B", locality: "L", city: "Bengaluru", state: "Karnataka", areaCode: "560008" };
const order = {
  transactionId: "t",
  city: "std:080",
  bpp: { id: "seller.test", uri: "https://seller.test" },
  providerId: "p",
  locationId: "l",
  lines: [{ itemId: "i", count: 1 }],
};
const confirmInput = (over: Record<string, unknown> = {}, pay: Record<string, unknown> = {}) => ({
  ...order,
  orderId: "o1",
  billing: { name: "A", phone: "9999999999", email: "a@b.in", address: addr, at: new Date() },
  delivery: { fulfillmentId: "f", gps: "12.97,77.59", address: addr, phone: "9999999999", email: "a@b.in", personName: "A", tat: "PT60M" },
  quote: { price: { currency: "INR", value: "250.00" }, breakup: [] },
  payment: {
    collectedBy: "BAP" as const,
    amountPaise: 25000,
    gatewayTransactionId: "cf_1",
    paid: true,
    finderFeePercent: 3,
    settlementDetails: [{ settlement_counterparty: "seller-app" }],
    ...pay,
  },
  terms: { seller: [{ code: "tax_number", value: "29AAECN5025F1ZK" }], buyerGstin: "00ALGTH0000A1Z0" },
  ...over,
});
const stop = (gps: string) => ({ gps, address: "x", area: "560001" });

describe("ONDC review, second pass", () => {
  it("a server whose subscriber id differs from the one its messages carry is flagged at boot", () => {
    expect(subscriberIdProblem(undefined)).toBeNull();
    expect(subscriberIdProblem(BAP_ID)).toBeNull();
    expect(subscriberIdProblem("www.flouna.com")).toMatch(/refused/);
  });

  it("a seller's answer to a complaint reaches us instead of a 404", async () => {
    // IGM replies go to bap_uri + /on_issue, the same base as every other callback.
    for (const action of ["on_issue", "on_issue_status"]) {
      const body = envelope(action);
      const rec: ReceivedCallback[] = [];
      const res = await request(testApp(async (cb) => void rec.push(cb)))
        .post(`/ondc/${action}`)
        .set("Content-Type", "application/json")
        .set("Authorization", sign(body))
        .send(body);
      expect(res.status).toBe(200);
      expect(rec).toHaveLength(1);
    }
  });

  it("two copies of a message arriving together are stored once", async () => {
    const body = envelope("on_confirm");
    const auth = sign(body);
    let stored = 0;
    const a = testApp(async () => {
      await new Promise((r) => setTimeout(r, 50));
      stored++;
    });
    const send = () => request(a).post("/ondc/on_confirm").set("Content-Type", "application/json").set("Authorization", auth).send(body);
    const [x, y] = await Promise.all([send(), send()]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(stored).toBe(1);
  });

  it("a message signed long ago cannot be replayed with a far off expiry", async () => {
    // A sender chooses its own expires. Signed two days ago and valid for a
    // year, it would outlive any memory of having seen it.
    const created = Math.floor(Date.now() / 1000) - 2 * 86400;
    const body = "{}";
    const header = createAuthorizationHeader(body, identity, created).replace(
      /expires="\d+"/,
      `expires="${created + 365 * 86400}"`,
    );
    // Re-sign with the forged expiry so only the age is wrong.
    const forged = (() => {
      const k = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seller.priv, "base64")]),
        format: "der",
        type: "pkcs8",
      });
      const digest = crypto.createHash("blake2b512").update(body).digest("base64");
      const expires = created + 365 * 86400;
      const sig = crypto.sign(null, Buffer.from(`(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`), k).toString("base64");
      return header.replace(/signature="[^"]*"/, `signature="${sig}"`);
    })();
    const res = await verifyAuthorizationHeader(forged, body, async () => seller.pub);
    expect(res).toEqual({ ok: false, reason: "expired" });
    // A message signed a minute ago is still fine.
    const fresh = createAuthorizationHeader(body, { ...identity, signingPrivateKey: seller.priv }, Math.floor(Date.now() / 1000) - 60);
    expect((await verifyAuthorizationHeader(fresh, body, async () => seller.pub)).ok).toBe(true);
    expect(SIGNATURE_TTL_SECONDS).toBe(3600);
  });

  it("an unsigned request to a callback is refused before its body is read", async () => {
    const res = await request(fullApp)
      .post("/ondc/on_search")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ context: { action: "on_search" } }));
    expect(res.status).toBe(401);
    expect(res.body.message.ack.status).toBe("NACK");
    // A large unsigned body is refused without being read. The server answers
    // and closes while the client is still sending, so the client may see the
    // 401 or the connection reset; what it must never see is the body parsed.
    const outcome = await request(fullApp)
      .post("/ondc/on_search")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ context: { action: "on_search" }, pad: "x".repeat(4_000_000) }))
      .then((r) => r.status, (e: NodeJS.ErrnoException) => e.code);
    expect([401, "ECONNRESET", "EPIPE"]).toContain(outcome);
  });

  it("the registry handshake still works without a signature", async () => {
    const res = await request(fullApp).post("/ondc/on_subscribe").set("Content-Type", "application/json").send({ challenge: "x" });
    expect(res.status).not.toBe(401);
  });

  it("a participant listed once per domain is found by its subscribed entry", async () => {
    const base: Participant = {
      subscriber_id: "seller.test",
      ukId: "s1",
      status: "SUBSCRIBED",
      type: "BPP",
      domain: "ONDC:RET11",
      subscriber_url: "https://seller.test",
      signing_public_key: seller.pub,
      encr_public_key: "",
      valid_from: "2020-01-01T00:00:00.000Z",
      valid_until: "2099-01-01T00:00:00.000Z",
    };
    const client = createRegistryClient({
      registryUrl: "https://registry.test",
      identity,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => [{ ...base, domain: "ONDC:RET10", status: "INITIATED" }, base],
      }),
    });
    expect(await client.publicKeyFor("seller.test", "s1")).toBe(seller.pub);
  });

  it("a burst of messages from one new seller asks the registry once", async () => {
    let calls = 0;
    const client = createRegistryClient({
      registryUrl: "https://registry.test",
      identity,
      fetch: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true, status: 200, json: async () => [] };
      },
    });
    await Promise.all(Array.from({ length: 20 }, () => client.publicKeyFor("seller.test", "s1")));
    expect(calls).toBe(1);
  });

  it("a gateway answering with JSON null is reported as its HTTP status, not as a network failure", async () => {
    const r = await sendSigned("https://gw.test", "search", { context: {}, message: {} }, { ...identity, signingPrivateKey: seller.priv }, async () => ({
      status: 500,
      text: async () => "null",
    }));
    expect(r).toMatchObject({ ack: false, status: 500 });
  });

  it("an order is not confirmed for a different amount than the seller quoted", () => {
    expect(() => buildConfirm(confirmInput({}, { amountPaise: 20000 }))).toThrow(/quote/);
    expect(() => buildConfirm(confirmInput())).not.toThrow();
  });

  it("an order we collect for is not confirmed unpaid or without where to settle the seller", () => {
    expect(() => buildConfirm(confirmInput({}, { paid: false }))).toThrow();
    expect(() => buildConfirm(confirmInput({}, { gatewayTransactionId: undefined }))).toThrow();
    expect(() => buildConfirm(confirmInput({}, { settlementDetails: [] }))).toThrow();
    // When the seller collects, none of that is ours to require.
    expect(() =>
      buildConfirm(confirmInput({}, { collectedBy: "BPP", paid: false, gatewayTransactionId: undefined, settlementDetails: [] })),
    ).not.toThrow();
  });

  it("a cart line must be a whole number of items, and add-ons need their item", () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildSelect({ ...order, lines: [{ itemId: "i", count }], gps: "12.97,77.59", areaCode: "560008" })).toThrow();
    }
    expect(() =>
      buildSelect({
        ...order,
        lines: [{ itemId: "i", count: 1, customizations: [{ itemId: "c", groupId: "g" }] }],
        gps: "12.97,77.59",
        areaCode: "560008",
      }),
    ).toThrow(/parent/);
  });

  it("locations, cities and terms that are not what ONDC expects stop the message", () => {
    expect(() => buildSelect({ ...order, gps: "Bengaluru", areaCode: "560008" })).toThrow(/gps/i);
    expect(() => buildSelect({ ...order, gps: "12.97,77.59", areaCode: "56008" })).toThrow(/area/i);
    expect(() => buildSelect({ ...order, city: "080", gps: "12.97,77.59", areaCode: "560008" })).toThrow(/city/i);
    const ride = {
      transactionId: "t",
      city: "std:080",
      pickup: stop("12.97,77.59"),
      drop: stop("12.93,77.62"),
      finderFeePercent: 1,
      staticTermsUrl: "https://flouna.com/ondc/terms",
    };
    expect(() => buildRideSearch(ride)).not.toThrow();
    expect(() => buildRideSearch({ ...ride, staticTermsUrl: "flouna.com/terms" })).toThrow(/terms/i);
    expect(() => buildRideSearch({ ...ride, delayInterestPercent: Number.NaN })).toThrow();
    expect(() => buildRideSearch({ ...ride, pickup: stop("91,77") })).toThrow(/gps/i);
  });

  it("a ride is never offered as paid to Flouna, which has no way to take that payment", () => {
    const base = {
      transactionId: "t",
      city: "std:080",
      bpp: { id: "p.test", uri: "https://p.test" },
      providerId: "p",
      itemId: "i",
      fulfillmentId: "f",
      vehicle: "CAB" as const,
      pickup: stop("12.97,77.59"),
      drop: stop("12.93,77.62"),
      customer: { name: "A", phone: "9999999999" },
    };
    expect(() =>
      buildRideInit({ ...base, payment: { collectedBy: "BAP" as "BPP", params: {}, tags: [] } }),
    ).toThrow();
    expect(() => buildRideInit({ ...base, payment: { collectedBy: "BPP", params: {}, tags: [] } })).not.toThrow();
  });
});
