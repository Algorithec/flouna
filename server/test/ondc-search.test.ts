import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter } from "../src/modules/ondc/callbacks.routes.js";
import { recordInbound } from "../src/modules/ondc/index.js";
import { ondcSearchResults, startOndcSearch, stdCodeFor } from "../src/modules/ondc/search.service.js";
import { authedAgent } from "./helpers.js";

// A search of the ONDC network end to end: sent signed to the gateway, then
// answered by several real seller apps (their catalogues from ONDC's published
// certified flows) through the real callbacks endpoint into the database, and
// read back with each seller's details.

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/ondc-ret11-on_search.json", import.meta.url), "utf8")) as Record<string, any>;
const key = crypto.generateKeyPairSync("ed25519");
const sellerKey = {
  priv: key.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
  pub: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
};
const ourKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
const ourIdentity = () => ({ subscriberId: "ondc.flouna.com", uniqueKeyId: "k", signingPrivateKey: ourKey });

const callbacks = express();
callbacks.use(express.json({ limit: "5mb", verify: (req, _res, buf) => void ((req as express.Request & { rawBody?: Buffer }).rawBody = buf) }));
// Every seller app here signs with the test key, as each would with its own.
callbacks.use(createCallbacksRouter({ publicKeyFor: async () => sellerKey.pub, record: recordInbound }));

/** A real seller app's catalogue, answering our search. */
function answer(name: string, searchId: string, change?: (m: any) => void) {
  const m = structuredClone(fixtures[name]);
  change?.(m);
  m.context = { ...m.context, bap_id: "ondc.flouna.com", bap_uri: "https://ondc.flouna.com/ondc", transaction_id: searchId, message_id: crypto.randomUUID(), timestamp: new Date().toISOString() };
  const body = JSON.stringify(m);
  return request(callbacks)
    .post("/ondc/on_search")
    .set("Content-Type", "application/json")
    .set("Authorization", createAuthorizationHeader(body, { subscriberId: m.context.bpp_id, uniqueKeyId: "s", signingPrivateKey: sellerKey.priv }))
    .send(body);
}

async function customer(address: { city: string; lat?: number; lng?: number } | null) {
  const signedUp = await authedAgent({ withAddress: false });
  const user = await prisma.user.findUniqueOrThrow({ where: { email: signedUp.email } });
  if (address) {
    await prisma.address.create({
      data: { userId: user.id, label: "Home", line1: "1", city: address.city, state: "Delhi", pincode: "110030", lat: address.lat ?? null, lng: address.lng ?? null, isDefault: true },
    });
  }
  return { ...signedUp, userId: user.id };
}

describe("searching ONDC sellers", () => {
  it("sends a signed search from the customer's address and reads back every seller that answered", async () => {
    const c = await customer({ city: "New Delhi", lat: 28.5355, lng: 77.191 });
    const sent: { url: string; action: string; envelope: any }[] = [];
    const started = await startOndcSearch(c.userId, "pizza", {
      identity: ourIdentity,
      send: async (url, action, envelope) => {
        sent.push({ url, action, envelope });
        return { ack: true, status: 200 };
      },
    });
    expect("searchId" in started).toBe(true);
    const searchId = (started as { searchId: string }).searchId;
    expect(sent[0]!.url).toBe("https://preprod.gateway.ondc.org");
    expect(sent[0]!.action).toBe("search");
    expect(sent[0]!.envelope.context).toMatchObject({ action: "search", city: "std:011", transaction_id: searchId, bap_id: "ondc.flouna.com" });
    expect(sent[0]!.envelope.message.intent).toMatchObject({
      item: { descriptor: { name: "pizza" } },
      fulfillment: { end: { location: { gps: "28.535500,77.191000", address: { area_code: "110030" } } } },
      payment: { "@ondc/org/buyer_app_finder_fee_type": "percent" },
    });

    // Nothing has answered yet.
    expect((await ondcSearchResults(searchId, c.userId)).offers).toEqual([]);

    // Several seller apps answer with their catalogues.
    for (const seller of ["Easy_Pay", "DIGILEDGE", "EATIKO_SELLER_APP", "Buynxt_Greenreceipt"]) await answer(seller, searchId).expect(200);

    const results = await ondcSearchResults(searchId, c.userId);
    expect(results.status).toBe("searching");
    // Only pizza, only from stores that sell it and deliver here. Digivipani
    // has pizza too, but its Bengaluru store delivers within 15 km.
    expect(results.offers.length).toBeGreaterThan(0);
    expect(results.offers.some((o) => o.seller.appName === "Digivipani")).toBe(false);
    expect(results.offers.every((o) => o.name.toLowerCase().includes("pizza"))).toBe(true);
    expect(new Set(results.offers.map((o) => o.seller.name))).toEqual(new Set(["Pramaan Store 1", "Pramaan Store 2"]));
    const first = results.offers[0]!;
    expect(first.seller).toMatchObject({ appName: "ONDC Pramaan Seller Services", address: { city: "New Delhi" } });
    expect(first.distanceKm).toBeGreaterThan(0);
    expect(first.distanceKm).toBeLessThan(5);
    // Nearest first.
    const d = results.offers.map((o) => o.distanceKm ?? Infinity);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(results.stores).toBe(2);
    expect(results.sellerApps).toBe(1);

    // After the window, the search reports itself complete.
    expect((await ondcSearchResults(searchId, c.userId, new Date(Date.now() + 60_000))).status).toBe("complete");
  });

  it("lists the nearer store first", async () => {
    const c = await customer({ city: "New Delhi", lat: 28.5273, lng: 77.1821 });
    const started = (await startOndcSearch(c.userId, "pizza", { identity: ourIdentity, send: async () => ({ ack: true, status: 200 }) })) as { searchId: string };
    // Store 1 moved about 20 km away; store 2 stays at the customer's door.
    await answer("Easy_Pay", started.searchId, (m) => {
      m.message.catalog["bpp/providers"][0].locations[0].gps = "28.700000,77.100000";
    }).expect(200);
    const results = await ondcSearchResults(started.searchId, c.userId);
    expect(results.offers[0]!.seller.name).toBe("Pramaan Store 2");
    expect(results.offers.at(-1)!.seller.name).toBe("Pramaan Store 1");
  });

  it("finds a dish across different seller apps", async () => {
    const c = await customer({ city: "Mumbai", lat: 19.0654, lng: 72.8323 });
    const started = (await startOndcSearch(c.userId, "shake", { identity: ourIdentity, send: async () => ({ ack: true, status: 200 }) })) as { searchId: string };
    for (const seller of ["Easy_Pay", "DIGILEDGE", "Buynxt_Greenreceipt"]) await answer(seller, started.searchId).expect(200);
    const results = await ondcSearchResults(started.searchId, c.userId);
    expect(results.offers.length).toBeGreaterThan(0);
    expect(results.offers[0]!.seller.name).toBe("Tim Hortons-Bandra");
    expect(results.offers[0]!.distanceKm).toBeLessThan(1);
  });

  it("only lets the customer who searched read the results", async () => {
    const c = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    const other = await customer(null);
    const started = (await startOndcSearch(c.userId, "pizza", { identity: ourIdentity, send: async () => ({ ack: true, status: 200 }) })) as { searchId: string };
    await other.agent.get(`/api/ondc/search/${started.searchId}`).expect(404);
    await c.agent.get(`/api/ondc/search/${started.searchId}`).expect(200);
    await c.agent.get("/api/ondc/search/not-a-uuid").expect(404);
  });

  it("says why it cannot search instead of failing", async () => {
    const send = async () => ({ ack: true, status: 200 });
    const noAddress = await customer(null);
    expect(await startOndcSearch(noAddress.userId, "pizza", { identity: ourIdentity, send })).toEqual({ unavailable: expect.stringMatching(/delivery address/) });
    const noGps = await customer({ city: "New Delhi" });
    expect(await startOndcSearch(noGps.userId, "pizza", { identity: ourIdentity, send })).toEqual({ unavailable: expect.stringMatching(/map location/) });
    const elsewhere = await customer({ city: "Atlantis", lat: 1, lng: 1 });
    expect(await startOndcSearch(elsewhere.userId, "pizza", { identity: ourIdentity, send })).toEqual({ unavailable: expect.stringMatching(/not available for Atlantis/) });
    const unconfigured = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    expect(await startOndcSearch(unconfigured.userId, "pizza", { identity: () => null, send })).toEqual({ unavailable: expect.stringMatching(/not configured/) });
    const refused = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    expect(await startOndcSearch(refused.userId, "pizza", { identity: ourIdentity, send: async () => ({ ack: false, status: 503 }) })).toEqual({
      unavailable: expect.stringMatching(/did not accept/),
    });
  });

  it("names cities the way ONDC does", () => {
    expect(stdCodeFor("Bengaluru")).toBe("std:080");
    expect(stdCodeFor("BENGALURU URBAN")).toBe("std:080");
    expect(stdCodeFor(" hyderabad ")).toBe("std:040");
    expect(stdCodeFor("Atlantis")).toBeNull();
  });
});
