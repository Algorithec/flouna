import { describe, expect, it } from "vitest";
import { recommendFood } from "../src/modules/food/food.service.js";
import { quoteRidesTraced } from "../src/modules/rides/rides.service.js";
import { qualityOf, blendRating } from "../src/modules/ratings/blend.js";

// Customers rated their orders, we stored it, we displayed it, and the step it
// was collected for ignored it. Ranking used the catalogue baseline while the
// screen showed a community-blended number, so Flouna could call something its
// top-rated pick and print a rating lower than an alternative's.

describe("ranking on what customers actually said", () => {
  it("ranks the same numbers it displays", () => {
    const withoutCommunity = recommendFood({ query: "", priority: "rating" })!;
    const target = withoutCommunity.alternatives[0] ?? withoutCommunity.best;

    // Enough ratings to carry real weight, and clearly better than baseline.
    const community = new Map([[target.dishId, { average: 5, count: 400 }]]);
    const withCommunity = recommendFood({ query: "", priority: "rating", community })!;

    // The blended rating is what ranking saw, and it is the number shown.
    expect(blendRating(target.rating, community.get(target.dishId))).toBeGreaterThan(
      target.rating,
    );
    // Praise from four hundred people moves the pick.
    expect(withCommunity.best.dishId).toBe(target.dishId);
  });

  it("a badly rated dish stops being recommended", () => {
    const before = recommendFood({ query: "", priority: "rating" })!;
    const community = new Map([[before.best.dishId, { average: 1.2, count: 500 }]]);
    const after = recommendFood({ query: "", priority: "rating", community })!;
    expect(after.best.dishId).not.toBe(before.best.dishId);
  });

  it("two complaints are currently enough to unseat the top dish", () => {
    // Not an endorsement of that, a record of it. blendRating gives a rating
    // one tenth of its weight per review up to ten, so two one-star reviews
    // pull a 4.8 dish down by roughly three quarters of a star and it loses
    // the top slot. That threshold predates this change and is a product
    // decision, not one to make quietly while wiring ranking up: a handful of
    // accounts should probably not be able to move a dish that far.
    const before = recommendFood({ query: "", priority: "rating" })!;
    const community = new Map([[before.best.dishId, { average: 1.0, count: 2 }]]);
    const after = recommendFood({ query: "", priority: "rating", community })!;
    expect(after.best.dishId).not.toBe(before.best.dishId);
  });

  it("behaves exactly as before when no community data is passed", () => {
    // The offline paths and every existing caller.
    const a = recommendFood({ query: "", priority: "rating" })!;
    const b = recommendFood({ query: "", priority: "rating", community: new Map() })!;
    expect(b.best.dishId).toBe(a.best.dishId);
  });

  it("rides rank on rider ratings too", () => {
    const opts = { distanceKm: 8, rideMinutes: 24, vehicle: "any" as const, priority: "rating" as const };
    const before = quoteRidesTraced(opts);
    const worst = before.quotes[0]!.provider;

    const community = new Map([[worst, { average: 1.1, count: 600 }]]);
    const after = quoteRidesTraced({ ...opts, community });

    expect(after.quotes[0]!.provider).not.toBe(worst);
    // The decision log records the ranking that actually happened.
    expect(after.trace?.chosenKey).toBe(after.quotes[0]!.productName);
  });

  it("qualityOf reports no evidence as a count of zero, not as absent", () => {
    // An absent count switches confidence weighting off for the whole set, so
    // the difference matters.
    expect(qualityOf(4.5, undefined)).toEqual({ rating: 4.5, ratingCount: 0 });
    expect(qualityOf(4.5, { average: 5, count: 20 }).ratingCount).toBe(20);
  });
});
