import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { workbenchUrlProblem } from "../src/modules/ondc/context.js";
import { startRideSearch } from "../src/modules/ondc/rides.service.js";
import { startOndcSearch } from "../src/modules/ondc/search.service.js";
import { searchUrl } from "../src/modules/ondc/workbench.js";
import { authedAgent } from "./helpers.js";

// ONDC's workbench runs its test flows against a mock seller. Searches by the
// listed testers go there while it is set, and nobody else's ever do: a
// customer searching for dinner must reach real sellers through the gateway.

const WORKBENCH = "https://workbench.ondc.tech/api-service";
const GATEWAY = "https://preprod.gateway.ondc.org";
const ourKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
const identity = () => ({ subscriberId: "ondc.flouna.com", uniqueKeyId: "k", signingPrivateKey: ourKey });

async function customer() {
  const signedUp = await authedAgent({ withAddress: false });
  const user = await prisma.user.findUniqueOrThrow({ where: { email: signedUp.email } });
  await prisma.address.create({
    data: { userId: user.id, label: "Home", line1: "1", city: "Bengaluru", state: "Karnataka", pincode: "560043", lat: 13.008935, lng: 77.644408, isDefault: true },
  });
  return { email: user.email, userId: user.id };
}

function recorder() {
  const urls: string[] = [];
  const send = async (url: string) => {
    urls.push(url);
    return { ack: true, status: 200 };
  };
  return { urls, send };
}

describe("the workbench address", () => {
  it("is accepted only on ONDC's own hosts over https, as a plain base", () => {
    expect(workbenchUrlProblem(undefined)).toBeNull();
    expect(workbenchUrlProblem(WORKBENCH)).toBeNull();
    expect(workbenchUrlProblem("https://ondc.org/workbench")).toBeNull();
    for (const bad of [
      "http://workbench.ondc.tech/api-service",
      "https://workbench.ondc.tech.example.com/api-service",
      "https://evilondc.tech/api-service",
      "https://example.com/workbench.ondc.tech",
      "https://user:pass@workbench.ondc.tech/api-service",
      "https://workbench.ondc.tech/api-service?to=elsewhere",
      "not a url",
    ]) {
      expect(workbenchUrlProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("where a search goes", () => {
  it("sends a tester to the mock seller for the domain and version, and everyone else to the gateway", async () => {
    const tester = await customer();
    const other = await customer();
    const config = { workbench: `${WORKBENCH}/`, testers: new Set([tester.email.toLowerCase()]), registry: "preprod" as const };
    expect(await searchUrl(tester.userId, "ONDC:RET11", config)).toBe(`${WORKBENCH}/ONDC:RET11/1.2.0/seller`);
    expect(await searchUrl(tester.userId, "ONDC:TRV10", config)).toBe(`${WORKBENCH}/ONDC:TRV10/2.0.1/seller`);
    expect(await searchUrl(other.userId, "ONDC:RET11", config)).toBe(GATEWAY);
  });

  it("goes to the gateway when the workbench is unset, unsafe, or the registry is production", async () => {
    const tester = await customer();
    const testers = new Set([tester.email.toLowerCase()]);
    expect(await searchUrl(tester.userId, "ONDC:RET11", { testers, registry: "preprod" })).toBe(GATEWAY);
    expect(await searchUrl(tester.userId, "ONDC:RET11", { workbench: "https://example.com", testers, registry: "preprod" })).toBe(GATEWAY);
    expect(await searchUrl(tester.userId, "ONDC:RET11", { workbench: WORKBENCH, testers, registry: "prod" })).toBe("https://prod.gateway.ondc.org");
  });
});

describe("searches from the app while the workbench is set", () => {
  const SETTLEMENT = { ONDC_SETTLEMENT_ACCOUNT_NUMBER: "123456789012", ONDC_SETTLEMENT_IFSC: "HDFC0001234", ONDC_SETTLEMENT_BENEFICIARY: "Test Account" };
  let saved: Record<string, string | undefined> = {};
  let tester: { email: string; userId: string };
  beforeEach(async () => {
    saved = Object.fromEntries(Object.keys(SETTLEMENT).map((k) => [k, process.env[k]]));
    Object.assign(process.env, SETTLEMENT);
    tester = await customer();
    env.ONDC_WORKBENCH_URL = WORKBENCH;
    env.ONDC_SEARCH_TESTERS.add(tester.email.toLowerCase());
  });
  afterEach(() => {
    env.ONDC_WORKBENCH_URL = undefined;
    env.ONDC_SEARCH_TESTERS.delete(tester.email.toLowerCase());
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sends a tester's food search to the mock seller and a customer's to the gateway", async () => {
    const other = await customer();
    const r = recorder();
    expect("searchId" in (await startOndcSearch(tester.userId, "pizza", { identity, send: r.send }))).toBe(true);
    expect("searchId" in (await startOndcSearch(other.userId, "pizza", { identity, send: r.send }))).toBe(true);
    expect(r.urls).toEqual([`${WORKBENCH}/ONDC:RET11/1.2.0/seller`, GATEWAY]);
  });

  it("sends a tester's ride search to the mock seller and a rider's to the gateway", async () => {
    const other = await customer();
    const r = recorder();
    const trip = {
      pickup: { lat: 13.008935, lng: 77.644408, address: "Banaswadi, Bengaluru", area: "560043" },
      drop: { lat: 12.971186, lng: 77.586812, address: "Sampangiram Nagar, Bengaluru", area: "560001" },
      city: "Bengaluru",
    };
    await startRideSearch(tester.userId, trip, { identity, send: r.send });
    await startRideSearch(other.userId, trip, { identity, send: r.send });
    expect(r.urls).toEqual([`${WORKBENCH}/ONDC:TRV10/2.0.1/seller`, GATEWAY]);
  });
});
