import { describe, expect, it } from "vitest";
import {
  journeyMinutes,
  quoteRidesTraced,
  unmetRideNote,
} from "../src/modules/rides/rides.service.js";
import { authedAgent } from "./helpers.js";

// Stated limits applied to real ride quotes.
//
// Thresholds below are derived from the unconstrained quotes rather than typed
// in, so these keep testing the rule when catalogue prices change instead of
// breaking on a number.

const base = { distanceKm: 8, rideMinutes: 24 } as const;
const all = () => quoteRidesTraced({ ...base }).quotes;

describe("no stated limit changes nothing", () => {
  // quoteRides also serves the order route, which recomputes the fare at
  // booking. Anything this path does without a limit, that path does too.
  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", {}],
  ])("returns every option, in the same order, when the limit is %s", (_, constraints) => {
    const plain = quoteRidesTraced({ ...base });
    const withNone = quoteRidesTraced({ ...base, constraints });
    expect(withNone.quotes.map((q) => q.productName)).toEqual(
      plain.quotes.map((q) => q.productName),
    );
    expect(withNone.unmet).toBeNull();
  });
});

describe("a longest acceptable wait for pickup", () => {
  it("removes every ride that would keep the rider waiting longer", () => {
    const waits = all().map((q) => q.pickupEtaMinutes).sort((a, b) => a - b);
    const limit = waits[Math.floor(waits.length / 2)]!;
    const r = quoteRidesTraced({ ...base, constraints: { maxPickupMinutes: limit } });

    expect(r.quotes.length).toBeGreaterThan(0);
    for (const q of r.quotes) expect(q.pickupEtaMinutes).toBeLessThanOrEqual(limit);
  });

  it("records the removals under their own rule in the decision trace", () => {
    const fastest = Math.min(...all().map((q) => q.pickupEtaMinutes));
    const r = quoteRidesTraced({ ...base, constraints: { maxPickupMinutes: fastest } });
    const pickupRule = r.trace?.exclusions.find((e) => e.rule === "max_pickup");

    expect(pickupRule?.count).toBe(all().length - r.quotes.length);
  });
});

describe("a stated maximum fare", () => {
  it("never lets a dearer ride through, however well it scores", () => {
    const fares = all().map((q) => q.effectivePaise).sort((a, b) => a - b);
    const limit = fares[1]!;
    for (const priority of ["balanced", "price", "rating", "speed"] as const) {
      const r = quoteRidesTraced({ ...base, priority, constraints: { maxPricePaise: limit } });
      for (const q of r.quotes) expect(q.effectivePaise).toBeLessThanOrEqual(limit);
    }
  });
});

describe("when the limits rule out everything", () => {
  const cheapest = () => Math.min(...all().map((q) => q.effectivePaise));

  it("returns nothing to rank rather than waiving the limit", () => {
    const r = quoteRidesTraced({ ...base, constraints: { maxPricePaise: cheapest() - 100 } });
    expect(r.quotes).toEqual([]);
    expect(r.trace).toBeNull();
  });

  it("names the nearest ride so the rider can be told what exists", () => {
    const limit = cheapest() - 100;
    const r = quoteRidesTraced({ ...base, constraints: { maxPricePaise: limit } });
    expect(r.unmet?.rule).toBe("max_price");
    expect(r.unmet?.item.effectivePaise).toBe(cheapest());
    expect(r.unmet?.by).toBe(100);
  });
});

describe("badges on what is left", () => {
  it("never calls a removed ride the best price", () => {
    // Autos over three kilometres, where the cheapest auto also has one of
    // the longer waits. An earlier version of this test ruled out the
    // cheapest ride across every vehicle, but that ride also had the shortest
    // wait, so the limit removed everything, the test returned early, and it
    // passed while asserting nothing. The preconditions below are checked
    // rather than assumed, so a catalogue change fails this loudly instead of
    // quietly emptying it again.
    const scene = { distanceKm: 3, rideMinutes: 24, vehicle: "auto" } as const;
    const unconstrained = quoteRidesTraced(scene).quotes;
    const cheapest = unconstrained.reduce((a, b) =>
      b.effectivePaise < a.effectivePaise ? b : a,
    );
    const r = quoteRidesTraced({ ...scene, constraints: { maxPickupMinutes: 4 } });

    expect(r.quotes.length).toBeGreaterThan(0);
    expect(r.quotes.map((q) => q.productName)).not.toContain(cheapest.productName);

    const labelled = r.quotes.filter((q) => q.badge === "BEST PRICE");
    expect(labelled).toHaveLength(1);
    expect(labelled[0]!.effectivePaise).toBe(
      Math.min(...r.quotes.map((q) => q.effectivePaise)),
    );
  });
});

describe("the whole journey, not only the wait", () => {
  it("counts the trip as well as the pickup", () => {
    expect(journeyMinutes({ pickupEtaMinutes: 4, rideMinutes: 25 })).toBe(29);
  });

  it("prefers the shorter journey over the shorter wait", () => {
    // The guide's case. Ranking on pickup alone would pick the first; the
    // rider arrives 23 minutes sooner in the second.
    const quick = { pickupEtaMinutes: 2, rideMinutes: 50 };
    const slow = { pickupEtaMinutes: 4, rideMinutes: 25 };
    expect(journeyMinutes(slow)).toBeLessThan(journeyMinutes(quick));
  });

  it("records the journey, not the wait, in the decision trace", () => {
    const r = quoteRidesTraced({ ...base });
    for (const row of r.trace!.scores) {
      const q = r.quotes.find((x) => x.productName === row.key)!;
      expect(row.etaMinutes).toBe(q.pickupEtaMinutes + q.rideMinutes);
    }
  });

  it("applies a latest-arrival limit to the whole journey", () => {
    const shortest = Math.min(...all().map(journeyMinutes));
    const r = quoteRidesTraced({ ...base, constraints: { maxEtaMinutes: shortest } });
    for (const q of r.quotes) expect(journeyMinutes(q)).toBeLessThanOrEqual(shortest);
    expect(r.quotes.length).toBeGreaterThan(0);
  });
});

describe("counting what was removed", () => {
  it("keeps vehicle filtering and stated limits as separate reasons", () => {
    const cabs = quoteRidesTraced({ ...base, vehicle: "cab" }).quotes;
    const limit = Math.min(...cabs.map((q) => q.effectivePaise));
    const r = quoteRidesTraced({
      ...base,
      vehicle: "cab",
      constraints: { maxPricePaise: limit },
    });
    const rules = r.trace!.exclusions.map((e) => e.rule);

    expect(rules).toContain("vehicle_type");
    expect(rules).toContain("max_price");
    expect(r.trace!.excludedCount).toBe(
      r.trace!.exclusions.reduce((s, e) => s + e.count, 0),
    );
  });
});

// The limits have to reach the screen that prices the real trip.
//
// Chat quotes a placeholder 8 km ride, so a stated fare could not honestly be
// enforced there and was left out of the ranking. It was then also left out of
// everything downstream: the booking card re-priced the real route with no
// limit at all, so a reply that said "within your budget" was followed by a
// list of fares well above it. The limits now travel to the quotes route,
// which is the one place the route is known.
describe("the quotes route applies the limits the rider stated", () => {
  const TRIP = "distanceKm=8.20&rideMinutes=24&vehicle=any";

  it("returns every fare when no limit is stated", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get(`/api/rides/quotes?${TRIP}`).expect(200);
    expect(res.body.quotes.length).toBe(quoteRidesTraced({ distanceKm: 8.2, rideMinutes: 24 }).quotes.length);
    expect(res.body.unmetNote).toBeUndefined();
  });

  it("drops every fare above a stated maximum", async () => {
    const { agent } = await authedAgent();
    const all = await agent.get(`/api/rides/quotes?${TRIP}`).expect(200);
    const fares = all.body.quotes.map((q: { effectivePaise: number }) => q.effectivePaise);
    // A limit that is real: some options are under it and some are over, so a
    // route that ignored the limit would be caught rather than pass by luck.
    const limit = Math.round((Math.min(...fares) + Math.max(...fares)) / 2);
    expect(fares.some((f: number) => f > limit)).toBe(true);
    expect(fares.some((f: number) => f <= limit)).toBe(true);

    const res = await agent
      .get(`/api/rides/quotes?${TRIP}&maxFarePaise=${limit}`)
      .expect(200);
    expect(res.body.quotes.length).toBeGreaterThan(0);
    for (const q of res.body.quotes) expect(q.effectivePaise).toBeLessThanOrEqual(limit);
    expect(res.body.quotes.length).toBeLessThan(fares.length);
    expect(res.body.unmetNote).toBeUndefined();
  });

  it("drops every fare that cannot pick up in time", async () => {
    const { agent } = await authedAgent();
    const all = await agent.get(`/api/rides/quotes?${TRIP}`).expect(200);
    const waits = all.body.quotes.map((q: { pickupEtaMinutes: number }) => q.pickupEtaMinutes);
    const limit = Math.round((Math.min(...waits) + Math.max(...waits)) / 2);
    expect(waits.some((w: number) => w > limit)).toBe(true);

    const res = await agent
      .get(`/api/rides/quotes?${TRIP}&maxPickupMinutes=${limit}`)
      .expect(200);
    expect(res.body.quotes.length).toBeGreaterThan(0);
    for (const q of res.body.quotes) expect(q.pickupEtaMinutes).toBeLessThanOrEqual(limit);
  });

  it("says why, and offers nothing, when the limit rules everything out", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get(`/api/rides/quotes?${TRIP}&maxFarePaise=100`).expect(200);

    expect(res.body.quotes).toEqual([]);
    // The nearest option is named as information, never handed over as one to
    // book: a client given the quote will eventually draw it.
    expect(res.body.unmetNote).toMatch(/No ride comes in under ₹1 for this trip\. The cheapest is ₹\d+/);
    expect(JSON.stringify(res.body)).not.toMatch(/"effectivePaise"/);
  });

  it("still records the ranking it made under the limit", async () => {
    const { agent } = await authedAgent();
    const res = await agent
      .get(`/api/rides/quotes?${TRIP}&maxPickupMinutes=4`)
      .expect(200);
    // A constrained ranking is still a decision, and the booking made from it
    // still has to pair.
    expect(typeof res.body.decisionId).toBe("string");
  });

  it("refuses a limit that is not a number, rather than ignoring it", async () => {
    // Silently dropping an unparseable limit is how a limit stops being
    // applied without anybody noticing.
    const { agent } = await authedAgent();
    await agent.get(`/api/rides/quotes?${TRIP}&maxFarePaise=cheap`).expect(400);
    await agent.get(`/api/rides/quotes?${TRIP}&maxFarePaise=-500`).expect(400);
  });
});

describe("what the rider is told when nothing fits", () => {
  it.each([
    [
      "a fare limit",
      { maxPricePaise: 100 },
      /No ride comes in under ₹1 for this trip\. The cheapest is ₹\d+, .+\./,
    ],
    [
      "a pickup limit",
      { maxPickupMinutes: 1 },
      /No ride can pick you up within 1 minutes? right now\. The soonest is .+, \d+ minutes away\./,
    ],
    [
      "an arrival limit",
      { maxEtaMinutes: 1 },
      /No ride gets you there within 1 minutes?\. The quickest is .+, \d+ minutes\./,
    ],
  ])("names the limit and the closest miss for %s", (_, constraints, shape) => {
    const r = quoteRidesTraced({ ...base, constraints });
    expect(r.quotes).toEqual([]);
    expect(unmetRideNote(r.unmet!)).toMatch(shape);
  });
});
