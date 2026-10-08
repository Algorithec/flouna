import { describe, expect, it } from "vitest";
import { quoteRides } from "../src/modules/rides/rides.service.js";
import { authedAgent } from "./helpers.js";

// A fare is money, so the arithmetic that produces it is checked directly.
//
// The catalogue carries flat coupons: ₹50 off an auto, ₹25 off a bike. On a
// short trip those are worth more than the ride itself, and the total was
// clamped to zero rather than refused, so every ride under 2.2 km had at least
// one option priced at nothing. Being cheapest, it was badged BEST PRICE and
// ranked first, and the order route charges exactly this number, so the
// product gave away the ride the rider was most likely to take.

/** Every distance a city ride plausibly covers, in 200m steps. */
const distances = Array.from({ length: 150 }, (_, i) => Number(((i + 1) * 0.2).toFixed(1)));

describe("no ride is ever free", () => {
  it("prices every option above zero at every distance", () => {
    const free: string[] = [];
    for (const km of distances) {
      for (const q of quoteRides({ distanceKm: km, rideMinutes: Math.ceil(km * 3) })) {
        if (q.effectivePaise <= 0) free.push(`${km}km ${q.displayName} = ${q.effectivePaise}`);
      }
    }
    expect(free).toEqual([]);
  });

  it("charges at least the boarding fare even where the coupon exceeds the ride", () => {
    // 1 km: the ₹25 bike coupon and the ₹50 auto coupon both exceed the fare.
    const quotes = quoteRides({ distanceKm: 1, rideMinutes: 4 });
    for (const q of quotes) expect(q.effectivePaise).toBeGreaterThanOrEqual(1000);
  });
});

describe("an offer is shown only when it is fully applied", () => {
  it("never lists an offer the fare cannot absorb", () => {
    const quotes = quoteRides({ distanceKm: 1, rideMinutes: 4 });
    const withOffers = quotes.filter((q) => q.offers.length > 0);
    // Not "no offers anywhere": the claim is that any offer still listed is
    // one the fare can take in full.
    for (const q of withOffers) {
      const off = q.offers.reduce((s, o) => s + o.discountPaise, 0);
      expect(q.farePaise - off).toBe(q.effectivePaise);
      expect(q.effectivePaise).toBeGreaterThan(0);
    }
    expect(withOffers.length).toBe(0);
  });

  it("still applies the offers on a normal trip, in full", () => {
    // The fix must not have quietly deleted the offers: at 8 km they apply.
    const quotes = quoteRides({ distanceKm: 8, rideMinutes: 24 });
    const withOffers = quotes.filter((q) => q.offers.length > 0);
    expect(withOffers.length).toBeGreaterThan(0);
    for (const q of withOffers) {
      const off = q.offers.reduce((s, o) => s + o.discountPaise, 0);
      expect(off).toBeGreaterThan(0);
      expect(q.effectivePaise).toBe(q.farePaise - off);
    }
  });

  it("applies an offer from the first distance it fits and not before", () => {
    // The boundary, found rather than asserted: below it the offer is absent,
    // at and above it the offer comes off in full. A partly applied coupon
    // would break both halves.
    const named = "Bike Express";
    const fitted = distances.find((km) =>
      quoteRides({ distanceKm: km, rideMinutes: Math.ceil(km * 3) }).some(
        (q) => q.displayName === named && q.offers.length > 0,
      ),
    );
    expect(fitted).toBeDefined();
    const before = distances[distances.indexOf(fitted!) - 1]!;
    const below = quoteRides({ distanceKm: before, rideMinutes: 5 }).find(
      (q) => q.displayName === named,
    )!;
    const at = quoteRides({ distanceKm: fitted!, rideMinutes: 5 }).find(
      (q) => q.displayName === named,
    )!;
    expect(below.offers).toEqual([]);
    expect(below.effectivePaise).toBe(below.farePaise);
    expect(at.offers.length).toBe(1);
    expect(at.effectivePaise).toBe(at.farePaise - at.offers[0]!.discountPaise);
  });
});

describe("a booked short ride is charged for", () => {
  it("creates an order with a real amount, not a free one", async () => {
    const { agent } = await authedAgent();
    // Roughly a kilometre apart, inside Hyderabad.
    const res = await agent
      .post("/api/orders")
      .send({
        domain: "ride",
        provider: "rapido",
        productName: "Rapido Bike",
        pickup: "Hitech City",
        drop: "Kondapur",
        pickupLat: 17.4435,
        pickupLng: 78.3772,
        dropLat: 17.4525,
        dropLng: 78.3772,
      })
      .expect(201);

    expect(res.body.order.amount).toBeGreaterThan(0);
    // And the saving recorded against it cannot exceed what was charged.
    expect(res.body.order.savedPaise).toBeLessThanOrEqual(res.body.order.amount * 10);
  });
});
