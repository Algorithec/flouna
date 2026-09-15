import { describe, expect, it } from "vitest";
import { applyHardConstraints } from "../src/modules/advisor/constraints.js";

// The Rules Engine: what is invalid is removed before anything is ranked.
//
// The examples below are taken from the Context Engine developer guide, with
// its own numbers, so this file is the guide's acceptance test as much as the
// module's. If one of these fails, the product no longer does what the
// architecture says it does.

type Ride = { name: string; fare: number; pickup: number; trip: number };
const rideView = (r: Ride) => ({
  pricePaise: r.fare * 100,
  pickupMinutes: r.pickup,
  etaMinutes: r.pickup + r.trip,
});

type Dish = { name: string; price: number; eta: number; rating: number };
const dishView = (d: Dish) => ({ pricePaise: d.price * 100, etaMinutes: d.eta });

describe("the guide's ride example (section 8)", () => {
  // "I need to go to HITEC City now. Under ₹300 and I don't want to wait more
  // than 5 minutes."
  const rides: Ride[] = [
    { name: "Rapido Auto", fare: 220, pickup: 3, trip: 32 },
    { name: "Uber Cab", fare: 280, pickup: 8, trip: 27 },
    { name: "Ola Cab", fare: 250, pickup: 4, trip: 29 },
  ];

  it("removes Uber for an 8 minute pickup and keeps the other two", () => {
    const r = applyHardConstraints(rides, rideView, {
      maxPricePaise: 30000,
      maxPickupMinutes: 5,
    });
    expect(r.kept.map((x) => x.name)).toEqual(["Rapido Auto", "Ola Cab"]);
    expect(r.rejected).toEqual([{ rule: "max_pickup", count: 1 }]);
  });

  it("removes Uber even though its trip is the shortest of the three", () => {
    // The fastest trip is exactly the kind of strength that must not buy a
    // candidate back past a stated limit.
    const r = applyHardConstraints(rides, rideView, { maxPickupMinutes: 5 });
    expect(r.kept.find((x) => x.name === "Uber Cab")).toBeUndefined();
  });
});

describe("the guide's food example (section 11)", () => {
  // "Get me chicken biryani under ₹300, preferably spicy, within 35 minutes."
  const dishes: Dish[] = [
    { name: "Restaurant A", price: 249, eta: 28, rating: 4.5 },
    { name: "Restaurant B", price: 219, eta: 41, rating: 4.8 },
    { name: "Restaurant C", price: 279, eta: 31, rating: 4.6 },
  ];

  it("removes Restaurant B for 41 minutes against a 35 minute limit", () => {
    const r = applyHardConstraints(dishes, dishView, {
      maxPricePaise: 30000,
      maxEtaMinutes: 35,
    });
    expect(r.kept.map((x) => x.name)).toEqual(["Restaurant A", "Restaurant C"]);
    expect(r.rejected).toEqual([{ rule: "max_eta", count: 1 }]);
  });

  it("removes B despite it being both the cheapest and the highest rated", () => {
    const r = applyHardConstraints(dishes, dishView, { maxEtaMinutes: 35 });
    expect(r.kept.map((x) => x.name)).not.toContain("Restaurant B");
  });
});

describe("a stated price is a wall (section 6)", () => {
  it("does not let a ₹320 option survive a ₹300 maximum", () => {
    const options: Dish[] = [
      { name: "excellent but over", price: 320, eta: 10, rating: 5.0 },
      { name: "fits", price: 290, eta: 40, rating: 3.9 },
    ];
    const r = applyHardConstraints(options, dishView, { maxPricePaise: 30000 });
    expect(r.kept.map((x) => x.name)).toEqual(["fits"]);
  });

  it("keeps an option priced exactly at the limit", () => {
    // "Under ₹300" in ordinary speech includes ₹300. Rejecting the boundary
    // would refuse the very price the customer named.
    const r = applyHardConstraints(
      [{ name: "at the limit", price: 300, eta: 20, rating: 4 }],
      dishView,
      { maxPricePaise: 30000 },
    );
    expect(r.kept).toHaveLength(1);
  });

  it("is never waived when nothing survives", () => {
    const r = applyHardConstraints(
      [
        { name: "a", price: 320, eta: 20, rating: 4 },
        { name: "b", price: 450, eta: 20, rating: 4 },
      ],
      dishView,
      { maxPricePaise: 30000 },
    );
    expect(r.kept).toEqual([]);
  });
});

describe("when nothing survives", () => {
  it("names the nearest miss, as information rather than a recommendation", () => {
    const r = applyHardConstraints(
      [
        { name: "far", price: 450, eta: 20, rating: 4 },
        { name: "near", price: 320, eta: 20, rating: 4 },
      ],
      dishView,
      { maxPricePaise: 30000 },
    );
    expect(r.nearestMiss?.item.name).toBe("near");
    expect(r.nearestMiss?.rule).toBe("max_price");
    expect(r.nearestMiss?.by).toBe(2000);
  });

  it("compares misses across rules by how far over their own limit they are", () => {
    // ₹20 over ₹300 is under 7% over. Two minutes over a five minute wait is
    // 40% over. The price miss is the nearer one, although 2000 paise is a
    // larger raw number than 2 minutes.
    const r = applyHardConstraints(
      [
        { name: "slow pickup", fare: 200, pickup: 7, trip: 10 },
        { name: "slightly dear", fare: 320, pickup: 3, trip: 10 },
      ],
      rideView,
      { maxPricePaise: 30000, maxPickupMinutes: 5 },
    );
    expect(r.nearestMiss?.item.name).toBe("slightly dear");
  });

  it("offers no nearest miss while anything still fits", () => {
    const r = applyHardConstraints(
      [
        { name: "over", price: 320, eta: 20, rating: 4 },
        { name: "fits", price: 250, eta: 20, rating: 4 },
      ],
      dishView,
      { maxPricePaise: 30000 },
    );
    expect(r.nearestMiss).toBeNull();
  });
});

describe("counting what was removed", () => {
  it("counts a candidate that breaks several rules exactly once", () => {
    // The decision log records one total removed. Counting a doubly invalid
    // option under both rules would report more removals than candidates.
    const r = applyHardConstraints(
      [{ name: "breaks both", fare: 400, pickup: 9, trip: 10 }],
      rideView,
      { maxPricePaise: 30000, maxPickupMinutes: 5 },
    );
    const total = r.rejected.reduce((s, x) => s + x.count, 0);
    expect(total).toBe(1);
    expect(r.rejected).toEqual([{ rule: "max_price", count: 1 }]);
  });
});

describe("what counts as a constraint", () => {
  const options: Dish[] = [{ name: "any", price: 999, eta: 99, rating: 4 }];

  it.each([
    ["absent", {}],
    ["null", { maxPricePaise: null, maxEtaMinutes: null }],
    ["zero", { maxPricePaise: 0 }],
    ["negative", { maxEtaMinutes: -5 }],
    ["not a number", { maxPricePaise: Number.NaN }],
  ])("ignores a limit that is %s, rather than removing everything", (_, c) => {
    expect(applyHardConstraints(options, dishView, c).kept).toHaveLength(1);
  });

  it("ignores a pickup limit for anything without a pickup", () => {
    // Food has no pickup. A pickup limit carried over from a combo request
    // must not empty the food results.
    const r = applyHardConstraints(options, dishView, { maxPickupMinutes: 5 });
    expect(r.kept).toHaveLength(1);
  });

  it("does not mutate the list it was given", () => {
    const input: Dish[] = [
      { name: "a", price: 500, eta: 20, rating: 4 },
      { name: "b", price: 100, eta: 20, rating: 4 },
    ];
    const before = input.slice();
    applyHardConstraints(input, dishView, { maxPricePaise: 30000 });
    expect(input).toEqual(before);
  });
});
