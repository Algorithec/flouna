import { describe, expect, it } from "vitest";
import { scoreOptions } from "../src/modules/advisor/scoring.js";
import { qualityOf } from "../src/modules/ratings/blend.js";

// A rating is a claim, and a claim is only as good as the number of people
// making it. The ratings service already shrinks the displayed number toward
// the catalogue baseline by how many people rated, but the count was dropped
// before ranking, so a 4.9 from two people and a 4.6 from four thousand were
// treated as equals by the one step that decides who gets steered where.
//
// These go through `qualityOf`, which is how a rating actually reaches the
// scorer. Feeding raw community averages straight in would be testing a
// pipeline we do not have.

/** A catalogue baseline typical of the dishes we carry. */
const BASELINE = 4.3;

describe("confidence-weighted quality", () => {
  it("an established rating beats a thinly-rated higher one", () => {
    const items = [
      {
        pricePaise: 20000,
        etaMinutes: 30,
        name: "New Place",
        ...qualityOf(BASELINE, { average: 4.9, count: 2 }),
      },
      {
        pricePaise: 20000,
        etaMinutes: 30,
        name: "Established",
        ...qualityOf(BASELINE, { average: 4.6, count: 4000 }),
      },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Established");
  });

  it("a genuinely better option still wins once enough people agree", () => {
    // Confidence weighting must not become a moat for incumbents.
    const items = [
      {
        pricePaise: 20000,
        etaMinutes: 30,
        name: "Better",
        ...qualityOf(BASELINE, { average: 4.9, count: 900 }),
      },
      {
        pricePaise: 20000,
        etaMinutes: 30,
        name: "Established",
        ...qualityOf(BASELINE, { average: 4.6, count: 4000 }),
      },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Better");
  });

  it("a handful of complaints cannot sink an established option", () => {
    const items = [
      {
        pricePaise: 20000,
        etaMinutes: 30,
        name: "Two angry reviews",
        ...qualityOf(4.8, { average: 1, count: 2 }),
      },
      {
        pricePaise: 20000,
        etaMinutes: 30,
        name: "Steady",
        ...qualityOf(4.4, { average: 4.4, count: 900 }),
      },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Steady");
  });

  it("the count is what separates two identical averages", () => {
    const items = [
      { pricePaise: 20000, etaMinutes: 30, name: "Thin", rating: 4.6, ratingCount: 11 },
      { pricePaise: 20000, etaMinutes: 30, name: "Deep", rating: 4.6, ratingCount: 4000 },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Deep");
  });

  it("ranks unchanged when no source knows its counts", () => {
    // Documents the behaviour wherever a provider cannot tell us, which is
    // also exactly how this behaved before.
    const items = [
      { pricePaise: 20000, rating: 4.9, etaMinutes: 30, name: "Higher" },
      { pricePaise: 20000, rating: 4.6, etaMinutes: 30, name: "Lower" },
    ];
    expect(scoreOptions(items, "rating")[0]!.item.name).toBe("Higher");
  });

  it("still separates options when nobody has rated any of them", () => {
    // Every count zero is no evidence, so the penalty is identical across the
    // set and the catalogue baselines decide it, which is what we display.
    const items = [
      { pricePaise: 20000, etaMinutes: 30, name: "Lower", ...qualityOf(4.1, undefined) },
      { pricePaise: 20000, etaMinutes: 30, name: "Higher", ...qualityOf(4.8, undefined) },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Higher");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("one heavily rated option does not drag the whole set onto itself", () => {
    // An earlier version shrank toward the set's own mean. With a single rated
    // option that prior became that option, everything collapsed onto it, and
    // the most-rated won whether it was good or bad.
    const items = [
      { pricePaise: 20000, etaMinutes: 30, name: "Rated badly", ...qualityOf(4.5, { average: 1.2, count: 500 }) },
      { pricePaise: 20000, etaMinutes: 30, name: "Unrated but fine", ...qualityOf(4.6, undefined) },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Unrated but fine");
  });

  it("does not disturb a price-led decision", () => {
    const items = [
      { pricePaise: 10000, etaMinutes: 30, ...qualityOf(4.0, { average: 4.0, count: 5 }) },
      { pricePaise: 30000, etaMinutes: 30, ...qualityOf(4.9, { average: 4.9, count: 5000 }) },
    ];
    const ranked = scoreOptions(items, "price");
    expect(ranked[0]!.item.pricePaise).toBe(10000);
  });
});

// The two stages, made explicit.
//
// Review worked the numbers through the uncertainty discount alone and found
// a thin 4.9 still beating an established 4.6, which is correct for raw input.
// The test above passes because a rating reaches the scorer only after the
// baseline blend. These pin both stages to their values, so the mechanism is
// on the page rather than left for a reviewer to reconstruct.
describe("how a thin rating loses", () => {
  const SPREAD = 0.8;
  const CONFIDENCE_AT = 10;
  const discounted = (rating: number, count: number) =>
    rating - SPREAD / Math.sqrt(count + CONFIDENCE_AT);

  it("stage one, the blend, pulls a thin average most of the way to the baseline", () => {
    // Two ratings carry a fifth of the weight: 4.3 * 0.8 + 4.9 * 0.2 = 4.42,
    // displayed to one decimal.
    expect(qualityOf(BASELINE, { average: 4.9, count: 2 })).toEqual({ rating: 4.4, ratingCount: 2 });
    // Ten or more replace the baseline entirely.
    expect(qualityOf(BASELINE, { average: 4.6, count: 4000 })).toEqual({ rating: 4.6, ratingCount: 4000 });
  });

  it("stage two, the discount, then separates them", () => {
    expect(discounted(4.4, 2)).toBeCloseTo(4.169, 3);
    expect(discounted(4.6, 4000)).toBeCloseTo(4.587, 3);
    expect(discounted(4.4, 2)).toBeLessThan(discounted(4.6, 4000));
  });

  it("the discount alone is not enough, exactly as review calculated", () => {
    // Raw, unblended: 4.9 with 2 ratings is 4.669 and still wins. This is why
    // the blend is not optional, and why a test feeding raw averages to the
    // scorer would be testing a pipeline the product does not have.
    expect(discounted(4.9, 2)).toBeCloseTo(4.669, 3);
    expect(discounted(4.9, 2)).toBeGreaterThan(discounted(4.6, 4000));
    const raw = scoreOptions(
      [
        { pricePaise: 20000, etaMinutes: 30, name: "New Place", rating: 4.9, ratingCount: 2 },
        { pricePaise: 20000, etaMinutes: 30, name: "Established", rating: 4.6, ratingCount: 4000 },
      ],
      "rating",
    );
    expect(raw[0]!.item.name).toBe("New Place");
  });
});

// Two counts, one letter apart, meaning opposite things.
//
// `ratingsCount` is a fixed catalogue figure that arrived with the results
// page. `ratingCount` is what Flouna customers actually left, and it is the
// one confidence weighting reads. Mixing them up would hand the ranker 2,300
// pieces of evidence for a rating that three people produced, which is exactly
// the failure confidence weighting exists to prevent.
describe("catalogue ratings count is not evidence", () => {
  it("carries the catalogue figure through untouched", async () => {
    const { allQuotes } = await import("../src/modules/food/food.service.js");
    const { withCommunityRatings } = await import("../src/modules/ratings/ratings.service.js");

    const dish = allQuotes().find((q) => q.ratingsCount);
    expect(dish).toBeDefined();

    const [out] = await withCommunityRatings("food", [dish!], (q) => q.dishId);
    // The catalogue figure is display data and survives the blend unchanged.
    expect(out!.ratingsCount).toBe(dish!.ratingsCount);
    // The evidence count is the service's to set, and is never this number.
    expect(out!.ratingCount).not.toBe(dish!.ratingsCount);
  });

  it("uses a real count as evidence and the catalogue figure as neither", async () => {
    const { qualityOf } = await import("../src/modules/ratings/blend.js");
    // What the scorer is handed for a dish three people rated: three, not the
    // 2,300 sitting beside it on the same object.
    expect(qualityOf(4.5, { average: 4.9, count: 3 })).toEqual({
      rating: 4.6,
      ratingCount: 3,
    });
  });

  it("ranks on the evidence count, which the scorer is the only reader of", async () => {
    const { scoreOptions } = await import("../src/modules/advisor/scoring.js");
    // A thin rating with a large catalogue figure must not benefit from it:
    // the scorer takes ratingCount, and nothing hands it ratingsCount.
    const thin = { pricePaise: 20000, etaMinutes: 30, name: "thin", rating: 4.4, ratingCount: 2 };
    const solid = { pricePaise: 20000, etaMinutes: 30, name: "solid", rating: 4.6, ratingCount: 4000 };
    const ranked = scoreOptions([{ ...thin, ratingsCount: 9999 } as typeof thin, solid], "rating");
    expect(ranked[0]!.item.name).toBe("solid");
  });
});
