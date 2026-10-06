import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { fetchRoute, quoteRides } from "../src/modules/rides/rides.service.js";

// A ride is booked at the fare on the button, or not at all.
//
// The server prices the ride itself and never takes a price from the app.
// It can still tell the app what it showed, so that a fare which moved while
// the rider sat on the review screen is reported instead of charged.

const TRIP = { pickupLat: 17.4435, pickupLng: 78.3772, dropLat: 17.2403, dropLng: 78.4294 };
const ORDER = { domain: "ride", provider: "ondc", productName: "ONDC Cab", pickup: "A", drop: "B", ...TRIP };

async function fareNow() {
  const r = await fetchRoute(TRIP.pickupLat, TRIP.pickupLng, TRIP.dropLat, TRIP.dropLng);
  return quoteRides(r).find((q) => q.productName === "ONDC Cab")!.effectivePaise;
}

describe("the fare a rider agreed to", () => {
  it("books when it matches the server's own price", async () => {
    const { agent } = await authedAgent();
    const shown = await fareNow();
    const res = await agent.post("/api/orders").send({ ...ORDER, expectedPaise: shown }).expect(201);
    expect(res.body.order.amount).toBe(shown);
  });

  it("refuses, and says the new fare, when it has moved", async () => {
    const { agent, email } = await authedAgent();
    const shown = (await fareNow()) - 3000; // what an older screen said
    const res = await agent.post("/api/orders").send({ ...ORDER, expectedPaise: shown }).expect(409);
    expect(res.body.error).toMatch(/fare has changed to ₹\d+/i);
    const me = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await prisma.order.count({ where: { userId: me.id } })).toBe(0);
  });

  it("never lets the app set the price: the server's fare is what is charged", async () => {
    const { agent } = await authedAgent();
    const real = await fareNow();
    // Claiming a lower fare does not get a lower fare; it gets a refusal.
    await agent.post("/api/orders").send({ ...ORDER, expectedPaise: 100 }).expect(409);
    const ok = await agent.post("/api/orders").send({ ...ORDER, expectedPaise: real }).expect(201);
    expect(ok.body.order.amount).toBe(real);
  });

  it("still books for an app that does not send what it showed", async () => {
    const { agent } = await authedAgent();
    await agent.post("/api/orders").send(ORDER).expect(201);
  });
});
