import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter } from "../src/modules/ondc/callbacks.routes.js";
import { recordInbound } from "../src/modules/ondc/index.js";
import { parseRideOnSearch } from "../src/modules/ondc/rideReplies.js";
import {
  chooseRide,
  confirmRide,
  confirmRideCancel,
  initRide,
  keepRide,
  quoteRideCancel,
  rideOffers,
  rideView,
  startRideSearch,
  trackRide,
  type RideDeps,
} from "../src/modules/ondc/rides.service.js";
import { authedAgent } from "./helpers.js";

// A ride booked with an ONDC ride provider, end to end, answered by the
// replies in ONDC's own TRV10 2.0.1 examples (sample phone numbers replaced),
// signed, through the real callbacks endpoint.

const examples = JSON.parse(readFileSync(new URL("./fixtures/ondc-trv10-replies.json", import.meta.url), "utf8")) as Record<string, any>;
const fx = (name: string) => structuredClone(examples[name]);
const PROVIDER = "example-bpp.com";

const key = crypto.generateKeyPairSync("ed25519");
const providerKey = {
  priv: key.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
  pub: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
};
const ourKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
const identity = () => ({ subscriberId: "ondc.flouna.com", uniqueKeyId: "k", signingPrivateKey: ourKey });

const callbacks = express();
callbacks.use(express.json({ limit: "5mb", verify: (req, _res, buf) => void ((req as express.Request & { rawBody?: Buffer }).rawBody = buf) }));
callbacks.use(createCallbacksRouter({ publicKeyFor: async () => providerKey.pub, record: recordInbound }));

function reply(action: string, message: any, ctx: { txnId: string; messageId: string; from?: string; at?: Date }) {
  const from = ctx.from ?? PROVIDER;
  message.context = {
    ...message.context,
    action,
    bap_id: "ondc.flouna.com",
    bap_uri: "https://ondc.flouna.com/ondc",
    bpp_id: from,
    transaction_id: ctx.txnId,
    message_id: ctx.messageId,
    timestamp: (ctx.at ?? new Date()).toISOString(),
  };
  const body = JSON.stringify(message);
  return request(callbacks)
    .post(`/ondc/${action}`)
    .set("Content-Type", "application/json")
    .set("Authorization", createAuthorizationHeader(body, { subscriberId: from, uniqueKeyId: "s", signingPrivateKey: providerKey.priv }))
    .send(body);
}

type Sent = { url: string; action: string; envelope: any };
function recorder() {
  const sent: Sent[] = [];
  const deps: RideDeps = {
    identity,
    send: async (url, action, envelope) => {
      sent.push({ url, action, envelope });
      return { ack: true, status: 200 };
    },
  };
  return { sent, deps, last: () => sent[sent.length - 1]! };
}

const SETTLEMENT = { ONDC_SETTLEMENT_ACCOUNT_NUMBER: "123456789012", ONDC_SETTLEMENT_IFSC: "HDFC0001234", ONDC_SETTLEMENT_BENEFICIARY: "Test Account" };
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(SETTLEMENT).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SETTLEMENT);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const PICKUP = { lat: 13.008935, lng: 77.644408, address: "Banaswadi, Bengaluru", area: "560043" };
const DROP = { lat: 12.971186, lng: 77.586812, address: "Sampangiram Nagar, Bengaluru", area: "560001" };

async function rider() {
  const signedUp = await authedAgent({ withAddress: false });
  const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const user = await prisma.user.update({ where: { email: signedUp.email }, data: { phone } });
  return { ...signedUp, userId: user.id, phone };
}

/** A search that providers have answered. */
async function searched() {
  const c = await rider();
  const r = recorder();
  const { rideId } = await startRideSearch(c.userId, { pickup: PICKUP, drop: DROP, city: "Bengaluru" }, r.deps);
  const ride = await prisma.ondcRide.findUniqueOrThrow({ where: { id: rideId } });
  await reply("on_search", fx("on_search_0"), { txnId: ride.txnId, messageId: crypto.randomUUID() }).expect(200);
  return { c, r, rideId, txnId: ride.txnId };
}

/** Booked with the provider: choose, price, init, confirm. */
async function booked() {
  const s = await searched();
  await chooseRide(s.c.userId, s.rideId, { bppId: PROVIDER, providerId: "P1", itemId: "I1" }, s.r.deps);
  await reply("on_select", fx("on_select_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id }).expect(200);
  await initRide(s.c.userId, s.rideId, s.r.deps);
  await reply("on_init", fx("on_init_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id }).expect(200);
  await confirmRide(s.c.userId, s.rideId, s.r.deps);
  await reply("on_confirm", fx("on_confirm_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id, at: new Date("2026-10-22T08:00:00Z") }).expect(200);
  return s;
}

describe("booking a ride with an ONDC ride provider", () => {
  it("searches, prices, books and follows a ride to its end on the provider's signed replies", async () => {
    const s = await searched();
    expect(s.r.sent[0]).toMatchObject({ url: "https://preprod.gateway.ondc.org", action: "search" });
    expect(s.r.sent[0]!.envelope.context).toMatchObject({ domain: "ONDC:TRV10", version: "2.0.1", location: { city: { code: "std:080" } } });

    const { offers } = await rideOffers(s.c.userId, s.rideId);
    expect(offers.map((o) => [o.vehicle, o.farePaise])).toEqual([["AUTO_RICKSHAW", 14600], ["CAB", 20600]]);

    await chooseRide(s.c.userId, s.rideId, { bppId: PROVIDER, providerId: "P1", itemId: "I1" }, s.r.deps);
    expect(s.r.last()).toMatchObject({ url: "https://example-bpp.com/prod/seller/select", action: "select" });
    expect(s.r.last().envelope.context.transaction_id).toBe(s.txnId);
    await reply("on_select", fx("on_select_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id }).expect(200);
    expect(await rideView(s.c.userId, s.rideId)).toMatchObject({ status: "quoted", farePaise: 14600 });

    await initRide(s.c.userId, s.rideId, s.r.deps);
    const init = s.r.last().envelope.message.order;
    expect(init.fulfillments[0].customer.contact.phone).toBe(s.c.phone);
    // The provider collects the fare and pays Flouna's fee into Flouna's account.
    expect(init.payments[0]).toMatchObject({ collected_by: "BPP", params: { bank_account_number: "123456789012", bank_code: "HDFC0001234" } });
    await reply("on_init", fx("on_init_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id }).expect(200);
    expect((await rideView(s.c.userId, s.rideId)).status).toBe("ready");

    await confirmRide(s.c.userId, s.rideId, s.r.deps);
    expect(s.r.last().envelope.message.order.payments[0].id).toBe("PA1");
    await reply("on_confirm", fx("on_confirm_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id, at: new Date("2026-10-22T08:00:00Z") }).expect(200);
    let view = await rideView(s.c.userId, s.rideId);
    expect(view).toMatchObject({ status: "booked", rideState: "RIDE_ASSIGNED", driver: { name: "Jason Roy" }, vehicleInfo: { registration: "KA-01-AD-9876" }, startOtp: "234234" });

    // Updates the provider sends unasked; ONDC's own examples leave out the order id here.
    const steps: [string, string][] = [["on_status_1", "RIDE_ENROUTE_PICKUP"], ["on_status_2", "RIDE_STARTED"]];
    let t = Date.parse("2026-10-22T08:00:00Z");
    for (const [name, state] of steps) {
      t += 60_000;
      await reply("on_status", fx(name), { txnId: s.txnId, messageId: crypto.randomUUID(), at: new Date(t) }).expect(200);
      expect((await rideView(s.c.userId, s.rideId)).rideState).toBe(state);
    }
    // Once the ride has started, the start code is no use to anyone.
    expect((await rideView(s.c.userId, s.rideId)).startOtp).toBeNull();
    await reply("on_status", fx("on_status_3"), { txnId: s.txnId, messageId: crypto.randomUUID(), at: new Date(t + 60_000) }).expect(200);
    view = await rideView(s.c.userId, s.rideId);
    expect(view).toMatchObject({ status: "completed", rideState: "RIDE_ENDED" });
  });

  it("only books a ride that was offered for this search", async () => {
    const s = await searched();
    await expect(chooseRide(s.c.userId, s.rideId, { bppId: PROVIDER, providerId: "P1", itemId: "NOPE" }, s.r.deps)).rejects.toThrow(/not offered/);
    await expect(chooseRide(s.c.userId, s.rideId, { bppId: "other.example", providerId: "P1", itemId: "I1" }, s.r.deps)).rejects.toThrow(/not offered/);
    const stranger = await rider();
    await expect(chooseRide(stranger.userId, s.rideId, { bppId: PROVIDER, providerId: "P1", itemId: "I1" }, s.r.deps)).rejects.toThrow(/Ride not found/);
  });

  it("ignores a reply from any provider other than the one chosen, or not answering our request", async () => {
    const s = await searched();
    await chooseRide(s.c.userId, s.rideId, { bppId: PROVIDER, providerId: "P1", itemId: "I1" }, s.r.deps);
    const msg = s.r.last().envelope.context.message_id;
    await reply("on_select", fx("on_select_0"), { txnId: s.txnId, messageId: msg, from: "other.example" }).expect(200);
    await reply("on_select", fx("on_select_0"), { txnId: s.txnId, messageId: crypto.randomUUID() }).expect(200);
    expect((await rideView(s.c.userId, s.rideId)).status).toBe("selecting");
  });

  it("cannot book without Flouna's account for the provider's fee", async () => {
    const s = await searched();
    await chooseRide(s.c.userId, s.rideId, { bppId: PROVIDER, providerId: "P1", itemId: "I1" }, s.r.deps);
    await reply("on_select", fx("on_select_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id }).expect(200);
    for (const k of Object.keys(SETTLEMENT)) delete process.env[k];
    await expect(initRide(s.c.userId, s.rideId, s.r.deps)).rejects.toThrow(/account for ride providers' fees is not set up/);
    expect(s.r.last().action).toBe("select");
  });

  it("does not let an older status overwrite a newer one", async () => {
    const s = await booked();
    await reply("on_status", fx("on_status_2"), { txnId: s.txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-22T08:10:00Z") }).expect(200);
    await reply("on_status", fx("on_status_1"), { txnId: s.txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-22T08:05:00Z") }).expect(200);
    expect((await rideView(s.c.userId, s.rideId)).rideState).toBe("RIDE_STARTED");
  });
});

describe("cancelling a booked ride", () => {
  it("shows the fee first, cancels only when the rider confirms, and can be backed out of", async () => {
    const s = await booked();
    await quoteRideCancel(s.c.userId, s.rideId, "001", s.r.deps);
    expect(s.r.last().envelope.message).toMatchObject({ cancellation_reason_id: "001", descriptor: { code: "SOFT_CANCEL" }, order_id: "O1" });
    await reply("on_cancel", fx("on_cancel_2"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id, at: new Date("2026-10-22T08:02:00Z") }).expect(200);
    expect(await rideView(s.c.userId, s.rideId)).toMatchObject({ status: "cancel_quoted", cancelFeePaise: 1000 });

    // The rider keeps the ride: nothing was cancelled, so nothing is sent.
    const before = s.r.sent.length;
    await keepRide(s.c.userId, s.rideId);
    expect(s.r.sent.length).toBe(before);
    expect((await rideView(s.c.userId, s.rideId)).status).toBe("booked");
    await expect(confirmRideCancel(s.c.userId, s.rideId, s.r.deps)).rejects.toThrow(/what cancelling costs first/);

    await quoteRideCancel(s.c.userId, s.rideId, "001", s.r.deps);
    await reply("on_cancel", fx("on_cancel_2"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id, at: new Date("2026-10-22T08:03:00Z") }).expect(200);
    await confirmRideCancel(s.c.userId, s.rideId, s.r.deps);
    expect(s.r.last().envelope.message.descriptor.code).toBe("CONFIRM_CANCEL");
    await reply("on_cancel", fx("on_cancel_3"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id, at: new Date("2026-10-22T08:04:00Z") }).expect(200);
    expect(await rideView(s.c.userId, s.rideId)).toMatchObject({ status: "cancelled", rideState: "RIDE_CANCELLED" });
  });

  it("records a ride the provider cancels on its own", async () => {
    const s = await booked();
    await reply("on_update", fx("on_cancel_3"), { txnId: s.txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-22T08:05:00Z") }).expect(200);
    expect((await rideView(s.c.userId, s.rideId)).status).toBe("cancelled");
  });
});

describe("tracking a ride", () => {
  it("shows the vehicle's position, only from the ride's own provider", async () => {
    const s = await booked();
    await trackRide(s.c.userId, s.rideId, s.r.deps);
    expect(s.r.last()).toMatchObject({ action: "track", envelope: { message: { order_id: "O1" } } });
    await reply("on_track", fx("on_track_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id, from: "other.example" }).expect(200);
    expect((await rideView(s.c.userId, s.rideId)).tracking).toBeNull();
    await reply("on_track", fx("on_track_0"), { txnId: s.txnId, messageId: s.r.last().envelope.context.message_id }).expect(200);
    expect((await rideView(s.c.userId, s.rideId)).tracking).toMatchObject({ gps: "28.620976, 77.046732" });
  });
});

describe("reading ride catalogues", () => {
  it("reads each vehicle's fare and estimate range", () => {
    const offers = parseRideOnSearch(fx("on_search_0"));
    expect(offers[0]).toMatchObject({ itemId: "I1", fulfillmentId: "F1", vehicle: "AUTO_RICKSHAW", farePaise: 14600, minPaise: 13600, maxPaise: 17600, collectedBy: "BPP" });
    expect(offers[1]).toMatchObject({ vehicle: "CAB", variant: "SEDAN", farePaise: 20600 });
  });
});

describe("the ONDC ride routes", () => {
  it("are hidden while ONDC is off, and serve the rider's own rides when on", async () => {
    const s = await searched();
    await s.c.agent.get(`/api/ondc/rides/${s.rideId}`).expect(404);
    env.ONDC_SEARCH_ENABLED = true;
    try {
      expect((await s.c.agent.get(`/api/ondc/rides/${s.rideId}/offers`).expect(200)).body.offers).toHaveLength(2);
      const stranger = await authedAgent();
      await stranger.agent.get(`/api/ondc/rides/${s.rideId}`).expect(404);
      await s.c.agent.post(`/api/ondc/rides/${s.rideId}/cancel`).send({ reasonId: "999" }).expect(400);
    } finally {
      env.ONDC_SEARCH_ENABLED = false;
    }
  });
});
