import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { anonymise, pushPending, tokenFor, pruneNoLogs } from "../src/modules/ondc/observability.js";
import { sendSigned } from "../src/modules/ondc/transport.js";
import { createCallbacksRouter } from "../src/modules/ondc/callbacks.routes.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { buildSelect, buildInit, type Address } from "../src/modules/ondc/retail.js";

// ONDC Network Observability, against ONDC's "Schema for Pushing Logs on
// Network Observability API": every message both ways with its ACK or NACK,
// personal data masked, pushed with the profile's token.

const key = crypto.generateKeyPairSync("ed25519");
const priv = key.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
const pub = key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const identity = { subscriberId: "ondc.flouna.com", uniqueKeyId: "k", signingPrivateKey: priv };

// The actions ONDC's log API accepts in data.context.action, from its schema
// validation error message.
const ALLOWED_ACTIONS = "cancel,catalog_rejection,confirm,init,issue,issue_status,on_cancel,on_confirm,on_init,on_issue,on_issue_status,on_select,on_status,on_update,select,status,receiver_recon,on_receiver_recon,update,search,on_search,recon,on_recon,report,on_report,settle,on_settle,track,on_track,info,on_info".split(",");

const addr: Address = { name: "Asha Rao", building: "Flat 12, Lake View", locality: "Indiranagar", city: "Bengaluru", state: "Karnataka", areaCode: "560038" };
const order = {
  transactionId: "t-no",
  city: "std:080",
  bpp: { id: "seller.test", uri: "https://seller.test/ondc" },
  providerId: "P1",
  locationId: "L1",
  lines: [{ itemId: "I1", count: 1 }],
};

async function logs(where: Record<string, unknown> = {}) {
  // recordNo queues without waiting; give the writes a moment.
  for (let i = 0; i < 40; i++) {
    const rows = await prisma.ondcNoLog.findMany({ where, orderBy: { createdAt: "asc" } });
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

beforeEach(async () => {
  await prisma.ondcNoLog.deleteMany({});
  env.ONDC_NO_TOKEN_RETAIL = "retail-token";
  env.ONDC_NO_TOKEN_RIDE = "ride-token";
});
afterEach(() => {
  env.ONDC_NO_TOKEN_RETAIL = undefined;
  env.ONDC_NO_TOKEN_RIDE = undefined;
});

describe("what goes to ONDC's observability log", () => {
  it("masks the customer and keeps city, PIN code, dishes and the seller", () => {
    const init = buildInit({
      ...order,
      billing: { name: "Asha Rao", phone: "9876543210", email: "asha@example.com", address: addr, at: new Date() },
      delivery: { fulfillmentId: "F1", gps: "12.971600,77.594600", address: addr, phone: "9876543210", email: "asha@example.com" },
    });
    const masked = anonymise(init) as typeof init;
    const text = JSON.stringify(masked);
    for (const secret of ["Asha Rao", "9876543210", "asha@example.com", "Flat 12", "Indiranagar", "12.971600"]) expect(text).not.toContain(secret);
    expect(masked.message.order.billing.address).toMatchObject({ city: "Bengaluru", area_code: "560038", state: "Karnataka", name: "****" });
    expect(masked.message.order.fulfillments[0]!.end.location).toMatchObject({ gps: "****", address: { city: "Bengaluru", area_code: "560038" } });
    expect(masked.context).toEqual(init.context);
    expect(masked.message.order.provider).toEqual(init.message.order.provider);
  });

  it("keeps catalogue names and a store's own address, which are not personal", () => {
    const store = { message: { catalog: { "bpp/providers": [{ descriptor: { name: "Pramaan Store 1" }, locations: [{ address: { street: "633 Stagtrail Rd", city: "New Delhi" } }], items: [{ descriptor: { name: "Farmhouse Pizza" } }] }] } } };
    expect(anonymise(store)).toEqual(store);
  });

  it("masks a complainant but not the apps involved", () => {
    const issue = { message: { issue: { actors: [{ type: "CONSUMER", info: { org: { name: "ondc.flouna.com::ONDC:RET11" }, person: { name: "Asha Rao" }, contact: { phone: "9876543210", email: "asha@example.com" } } }] } } };
    const masked = anonymise(issue) as typeof issue;
    expect(masked.message.issue.actors[0]!.info).toEqual({ org: { name: "ondc.flouna.com::ONDC:RET11" }, person: { name: "****" }, contact: { phone: "****", email: "****" } });
  });

  it("uses each business profile's own token", () => {
    expect(tokenFor("ONDC:RET11")).toBe("retail-token");
    expect(tokenFor("ONDC:TRV10")).toBe("ride-token");
    expect(tokenFor("ONDC:FIS12")).toBeNull();
    expect(tokenFor(undefined)).toBeNull();
  });
});

describe("logging what we send", () => {
  it("logs the message and the seller's ACK, shaped as ONDC's schema asks", async () => {
    const select = buildSelect({ ...order, gps: "12.971600,77.594600", areaCode: "560038" });
    await sendSigned("https://seller.test/ondc", "select", select, identity, async () => ({ status: 200, text: async () => JSON.stringify({ message: { ack: { status: "ACK" } } }) }));
    const rows = await logs();
    await new Promise((r) => setTimeout(r, 100));
    const all = await prisma.ondcNoLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.length).toBeGreaterThan(0);
    expect(all.map((r) => r.type).sort()).toEqual(["select", "select_response"]);
    for (const r of all) {
      const body = JSON.parse(r.payload);
      // Exactly type and data: anything else draws ONDC's 2001 extra-field warning.
      expect(Object.keys(body).sort()).toEqual(["data", "type"]);
      expect(ALLOWED_ACTIONS).toContain(body.data.context.action);
      expect(r.domain).toBe("ONDC:RET11");
    }
    const response = JSON.parse(all.find((r) => r.type === "select_response")!.payload);
    expect(response.data).toEqual({ context: select.context, message: { ack: { status: "ACK" } } });
    expect(JSON.parse(all.find((r) => r.type === "select")!.payload).data.message.order.fulfillments[0].end.location.gps).toBe("****");
  });

  it("logs a seller's NACK with its error", async () => {
    const select = buildSelect({ ...order, gps: "12.971600,77.594600", areaCode: "560038" });
    await sendSigned("https://seller.test/ondc", "select", select, identity, async () => ({
      status: 200,
      text: async () => JSON.stringify({ message: { ack: { status: "NACK" } }, error: { type: "DOMAIN-ERROR", code: "30001", message: "Provider not found" } }),
    }));
    await logs({ type: "select_response" });
    const r = await prisma.ondcNoLog.findFirstOrThrow({ where: { type: "select_response" } });
    expect(JSON.parse(r.payload).data).toMatchObject({ message: { ack: { status: "NACK" } }, error: { type: "DOMAIN-ERROR", code: "30001" } });
  });

  it("logs a call that failed over HTTP as a TECH-ERROR with the status", async () => {
    const select = buildSelect({ ...order, gps: "12.971600,77.594600", areaCode: "560038" });
    await sendSigned("https://seller.test/ondc", "select", select, identity, async () => ({ status: 502, text: async () => "Bad Gateway" }));
    const [r] = await logs({ type: "select" });
    expect(JSON.parse(r!.payload).data.error).toMatchObject({ type: "TECH-ERROR", code: "502" });
    expect(await prisma.ondcNoLog.count({ where: { type: "select_response" } })).toBe(0);
    await prisma.ondcNoLog.deleteMany({});
    await sendSigned("https://seller.test/ondc", "select", select, identity, async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const [down] = await logs({ type: "select" });
    expect(JSON.parse(down!.payload).data.error).toMatchObject({ type: "TECH-ERROR", code: "503" });
  });

  it("queues nothing for a profile with no token", async () => {
    env.ONDC_NO_TOKEN_RETAIL = undefined;
    const select = buildSelect({ ...order, gps: "12.971600,77.594600", areaCode: "560038" });
    await sendSigned("https://seller.test/ondc", "select", select, identity, async () => ({ status: 200, text: async () => JSON.stringify({ message: { ack: { status: "ACK" } } }) }));
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.ondcNoLog.count()).toBe(0);
  });
});

describe("logging what sellers send us", () => {
  const app = () => {
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => void ((req as express.Request & { rawBody?: Buffer }).rawBody = buf) }));
    a.use(createCallbacksRouter({ publicKeyFor: async (s) => (s === "seller.test" ? pub : null), record: async () => ({ duplicate: false }) }));
    return a;
  };
  const onSearch = JSON.parse(readFileSync(new URL("./fixtures/ondc-ret11-on_search.json", import.meta.url), "utf8")).Easy_Pay;
  const body = () =>
    JSON.stringify({ ...onSearch, context: { ...onSearch.context, bap_id: "ondc.flouna.com", bpp_id: "seller.test", transaction_id: "t-in", message_id: crypto.randomUUID(), timestamp: new Date().toISOString() } });

  it("logs a seller's message and our ACK", async () => {
    const b = body();
    await request(app()).post("/ondc/on_search").set("Content-Type", "application/json")
      .set("Authorization", createAuthorizationHeader(b, { subscriberId: "seller.test", uniqueKeyId: "s", signingPrivateKey: priv })).send(b).expect(200);
    for (let i = 0; i < 40 && (await prisma.ondcNoLog.count()) < 2; i++) await new Promise((r) => setTimeout(r, 25));
    const types = (await prisma.ondcNoLog.findMany()).map((r) => r.type).sort();
    expect(types).toEqual(["on_search", "on_search_response"]);
    const response = JSON.parse((await prisma.ondcNoLog.findFirstOrThrow({ where: { type: "on_search_response" } })).payload);
    expect(response.data.message).toEqual({ ack: { status: "ACK" } });
  });

  it("logs a refused message with our NACK and its code", async () => {
    const b = body();
    const other = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
    await request(app()).post("/ondc/on_search").set("Content-Type", "application/json")
      .set("Authorization", createAuthorizationHeader(b, { subscriberId: "seller.test", uniqueKeyId: "s", signingPrivateKey: other })).send(b).expect(401);
    // Both rows, the message and our answer, before the test ends. Waiting
    // for one let the other land after the next test had cleared the table,
    // where it was counted as that test's unsent log.
    for (let i = 0; i < 40 && (await prisma.ondcNoLog.count()) < 2; i++) await new Promise((r) => setTimeout(r, 25));
    await logs({ type: "on_search_response" });
    const response = JSON.parse((await prisma.ondcNoLog.findFirstOrThrow({ where: { type: "on_search_response" } })).payload);
    expect(response.data).toMatchObject({ message: { ack: { status: "NACK" } }, error: { code: "20001" } });
  });
});

describe("pushing to ONDC", () => {
  const queue = async (domain: string, type: string) =>
    prisma.ondcNoLog.create({ data: { domain, type, payload: JSON.stringify({ type, data: { context: { domain, action: type } } }) } });

  it("sends each log with its profile's bearer token and marks it sent", async () => {
    const mine = [(await queue("ONDC:RET11", "on_search")).id, (await queue("ONDC:TRV10", "on_select")).id];
    const calls: { url: string; auth: string; body: string }[] = [];
    const r = await pushPending({
      url: "https://no.test/v1/api/push-txn-logs",
      fetch: async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization!, body: init.body });
        return { status: 200, text: async () => JSON.stringify({ message: "Successful" }) };
      },
    });
    expect(r).toEqual({ tried: 2, sent: 2 });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer retail-token", "Bearer ride-token"]);
    expect(JSON.parse(calls[0]!.body)).toEqual({ type: "on_search", data: { context: { domain: "ONDC:RET11", action: "on_search" } } });
    // Only this test's rows: a write still landing from another test is not one of them.
    expect(await prisma.ondcNoLog.count({ where: { sentAt: null, id: { in: mine } } })).toBe(0);
  });

  it("keeps a refused log with ONDC's reason and stops retrying after a limit", async () => {
    await queue("ONDC:RET11", "on_search");
    const refuse = async () => ({ status: 400, text: async () => JSON.stringify({ errors: [{ error_code: 4001, path: "data.context.bap_id" }] }) });
    for (let i = 0; i < 10; i++) await pushPending({ url: "https://no.test", fetch: refuse });
    const row = await prisma.ondcNoLog.findFirstOrThrow();
    expect(row.sentAt).toBeNull();
    expect(row.attempts).toBe(8);
    expect(row.lastError).toContain("4001");
  });

  it("drops logs a week after they were sent", async () => {
    const old = await queue("ONDC:RET11", "on_search");
    await prisma.ondcNoLog.update({ where: { id: old.id }, data: { sentAt: new Date() } });
    await pruneNoLogs(new Date(Date.now() + 8 * 86_400_000));
    expect(await prisma.ondcNoLog.count()).toBe(0);
  });
});
