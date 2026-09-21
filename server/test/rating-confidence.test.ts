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
