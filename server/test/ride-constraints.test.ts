import { describe, expect, it } from "vitest";
import {
  journeyMinutes,
  quoteRidesTraced,
} from "../src/modules/rides/rides.service.js";

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
