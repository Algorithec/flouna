import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter } from "../src/modules/ondc/callbacks.routes.js";
import { recordInbound } from "../src/modules/ondc/index.js";
import { ondcSearchResults, startOndcSearch, stdCodeFor } from "../src/modules/ondc/search.service.js";
import { app, authedAgent } from "./helpers.js";

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

  it("states our static terms on the search once they are published, and none before", async () => {
    const c = await customer({ city: "New Delhi", lat: 28.5355, lng: 77.191 });
    const sent: any[] = [];
    const send = async (_url: string, _action: string, envelope: unknown) => {
      sent.push(envelope);
      return { ack: true, status: 200 };
    };
    await startOndcSearch(c.userId, "pizza", { identity: ourIdentity, send });
    expect(sent[0].message.intent.tags).toBeUndefined();

    process.env.ONDC_STATIC_TERMS_URL = "https://flouna.com/ondc/static_terms.pdf";
    process.env.ONDC_STATIC_TERMS_EFFECTIVE_DATE = "2026-11-01";
    try {
      await startOndcSearch(c.userId, "pizza", { identity: ourIdentity, send });
    } finally {
      delete process.env.ONDC_STATIC_TERMS_URL;
      delete process.env.ONDC_STATIC_TERMS_EFFECTIVE_DATE;
    }
    expect(sent[1].message.intent.tags).toEqual([
      {
        code: "bap_terms",
        list: [
          { code: "static_terms", value: "" },
          { code: "static_terms_new", value: "https://flouna.com/ondc/static_terms.pdf" },
          { code: "effective_date", value: "2026-11-01T00:00:00.000Z" },
        ],
      },
    ]);
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
    env.ONDC_SEARCH_ENABLED = true;
    try {
      await other.agent.get(`/api/ondc/search/${started.searchId}`).expect(404);
      await c.agent.get(`/api/ondc/search/${started.searchId}`).expect(200);
      await c.agent.get("/api/ondc/search/not-a-uuid").expect(404);
    } finally {
      env.ONDC_SEARCH_ENABLED = false;
    }
  });

  it("lets a listed tester through while it is off for everyone else", async () => {
    const tester = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    const other = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    const send = async () => ({ ack: true, status: 200 });
    const started = (await startOndcSearch(tester.userId, "pizza", { identity: ourIdentity, send })) as { searchId: string };
    // The other customer's own search, so their 404 comes from the gate and
    // not from asking for someone else's search.
    const theirs = (await startOndcSearch(other.userId, "pizza", { identity: ourIdentity, send })) as { searchId: string };
    expect(env.ONDC_SEARCH_ENABLED).toBe(false);
    env.ONDC_SEARCH_TESTERS.add(tester.email.toLowerCase());
    try {
      await tester.agent.get(`/api/ondc/search/${started.searchId}`).expect(200);
      await tester.agent.post("/api/ondc/search").send({ query: "pizza" }).expect(202);
      await other.agent.get(`/api/ondc/search/${theirs.searchId}`).expect(404);
      await other.agent.post("/api/ondc/search").send({ query: "pizza" }).expect(404);
    } finally {
      env.ONDC_SEARCH_TESTERS.delete(tester.email.toLowerCase());
    }
  });

  it("is not there at all while ONDC search is switched off", async () => {
    const c = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    const started = (await startOndcSearch(c.userId, "pizza", { identity: ourIdentity, send: async () => ({ ack: true, status: 200 }) })) as { searchId: string };
    expect(env.ONDC_SEARCH_ENABLED).toBe(false);
    // Even the customer who searched, so test stores never reach anyone.
    await c.agent.get(`/api/ondc/search/${started.searchId}`).expect(404);
    await c.agent.post("/api/ondc/search").send({ query: "pizza" }).expect(404);
    // Signed out too: a 404, not a 401 that says the route is there.
    await request(app).get(`/api/ondc/search/${started.searchId}`).expect(404);
    await request(app).post("/api/ondc/search").send({ query: "pizza" }).expect(404);
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

  it("can return at once and send in the background, reporting a refusal through its status", async () => {
    const c = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    let release!: (r: { ack: boolean; status: number }) => void;
    const gate = new Promise<{ ack: boolean; status: number }>((r) => (release = r));
    const started = (await startOndcSearch(c.userId, "pizza", { identity: ourIdentity, send: () => gate, wait: false })) as { searchId: string };
    expect((await ondcSearchResults(started.searchId, c.userId)).status).toBe("searching");
    release({ ack: false, status: 503 });
    await new Promise((r) => setTimeout(r, 100));
    expect((await ondcSearchResults(started.searchId, c.userId)).status).toBe("refused");
  });

  it("names cities the way ONDC does", () => {
    expect(stdCodeFor("Bengaluru")).toBe("std:080");
    expect(stdCodeFor("BENGALURU URBAN")).toBe("std:080");
    expect(stdCodeFor(" hyderabad ")).toBe("std:040");
    expect(stdCodeFor("Atlantis")).toBeNull();
  });
});

describe("keeping ONDC searches only as long as they are useful", () => {
  it("drops old searches and their catalogues, keeping who answered", async () => {
    const { pruneOndcSearches } = await import("../src/modules/ondc/search.service.js");
    const c = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    const started = (await startOndcSearch(c.userId, "pizza", { identity: ourIdentity, send: async () => ({ ack: true, status: 200 }) })) as { searchId: string };
    await answer("Easy_Pay", started.searchId).expect(200);
    const later = new Date(Date.now() + 8 * 86_400_000);
    // A search from just now is untouched by a run today.
    await pruneOndcSearches(new Date());
    expect(await prisma.ondcSearch.count({ where: { id: started.searchId } })).toBe(1);
    // Eight days on, the search and its location are gone, and so is the catalogue body.
    await pruneOndcSearches(later);
    expect(await prisma.ondcSearch.count({ where: { id: started.searchId } })).toBe(0);
    const rows = await prisma.ondcTransaction.findMany({ where: { txnId: started.searchId, action: "on_search" } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.response === null && r.bppId)).toBe(true);
  });
});

describe("reading results while sellers answer", () => {
  it("parses each seller's catalogue once, however often the app asks", async () => {
    const mod = await import("../src/modules/ondc/search.service.js");
    const c = await customer({ city: "New Delhi", lat: 28.53, lng: 77.19 });
    const started = (await startOndcSearch(c.userId, "pizza", { identity: ourIdentity, send: async () => ({ ack: true, status: 200 }) })) as { searchId: string };
    await answer("Easy_Pay", started.searchId).expect(200);
    const before = mod.catalogueParses;
    const first = await ondcSearchResults(started.searchId, c.userId);
    for (let i = 0; i < 5; i++) await ondcSearchResults(started.searchId, c.userId);
    expect(mod.catalogueParses - before).toBe(1);
    // A new seller answering is read once too, and joins the results.
    await answer("DIGILEDGE", started.searchId).expect(200);
    const again = await ondcSearchResults(started.searchId, c.userId);
    expect(mod.catalogueParses - before).toBe(2);
    expect(again.offers.length).toBeGreaterThanOrEqual(first.offers.length);
  });
});

describe("who searches ONDC sellers", () => {
  it("is everyone when switched on, otherwise only the listed testers", async () => {
    const { ondcSearchFor } = await import("../src/modules/ondc/search.service.js");
    const tester = await customer(null);
    const other = await customer(null);
    const testers = new Set([tester.email.toLowerCase()]);
    expect(await ondcSearchFor(tester.userId, { enabled: false, testers })).toBe(true);
    expect(await ondcSearchFor(other.userId, { enabled: false, testers })).toBe(false);
    expect(await ondcSearchFor(other.userId, { enabled: true, testers: new Set() })).toBe(true);
    expect(await ondcSearchFor(tester.userId, { enabled: false, testers: new Set() })).toBe(false);
  });
});
