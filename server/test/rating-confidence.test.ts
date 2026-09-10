import { describe, expect, it } from "vitest";
import { scoreOptions } from "../src/modules/advisor/scoring.js";

// A rating is a claim, and a claim is only as good as the number of people
// making it. The displayed rating already accounts for that, but the count was
// dropped before ranking, so the engine treated a 4.9 from two people as the
// equal of a 4.6 from four thousand. Ranking is where it matters most: it
// decides who gets steered where.

describe("confidence-weighted quality", () => {
  it("an established rating beats a thinly-rated higher one", () => {
    const items = [
      { pricePaise: 20000, rating: 4.9, ratingCount: 2, etaMinutes: 30, name: "New Place" },
      { pricePaise: 20000, rating: 4.6, ratingCount: 4000, etaMinutes: 30, name: "Established" },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Established");
  });

  it("the same pair ranks the other way when the count is unknown", () => {
    // Documents the previous behaviour, and that it is what still happens
    // wherever a source cannot tell us how many ratings it has.
    const items = [
      { pricePaise: 20000, rating: 4.9, etaMinutes: 30, name: "New Place" },
      { pricePaise: 20000, rating: 4.6, etaMinutes: 30, name: "Established" },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("New Place");
  });

  it("a genuinely better option still wins once enough people agree", () => {
    // Confidence weighting must not become a moat for incumbents.
    const items = [
      { pricePaise: 20000, rating: 4.9, ratingCount: 900, etaMinutes: 30, name: "Better" },
      { pricePaise: 20000, rating: 4.6, ratingCount: 4000, etaMinutes: 30, name: "Established" },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Better");
  });

  it("is all or nothing across a set", () => {
    // Adjusting only the options whose counts we know would advantage the ones
    // we know least about, which is backwards.
    const mixed = [
      { pricePaise: 20000, rating: 4.9, ratingCount: 2, etaMinutes: 30, name: "Thin" },
      { pricePaise: 20000, rating: 4.6, etaMinutes: 30, name: "Unknown count" },
    ];
    const ranked = scoreOptions(mixed, "rating");
    expect(ranked[0]!.item.name).toBe("Thin");
  });

  it("treats an unrated newcomer as unknown, not as bad", () => {
    // Nobody has rated it yet, which is not the same as having been rated
    // badly. It should not win, and it should not be buried beneath an option
    // that plenty of people agree is poor.
    const items = [
      { pricePaise: 20000, rating: 0, ratingCount: 0, etaMinutes: 30, name: "Brand new" },
      { pricePaise: 20000, rating: 4.6, ratingCount: 4000, etaMinutes: 30, name: "Established" },
      { pricePaise: 20000, rating: 2.1, ratingCount: 800, etaMinutes: 30, name: "Known to be bad" },
    ];
    const names = scoreOptions(items, "rating").map((r) => r.item.name);
    expect(names[0]).toBe("Established");
    expect(names.indexOf("Brand new")).toBeLessThan(names.indexOf("Known to be bad"));
  });

  it("falls back to the catalogue when nobody has rated anything", () => {
    // Every count zero is no evidence at all. Weighting by it would shrink
    // every option to the same number, ratings would stop separating them, and
    // "top-rated" would return whatever happened to be first.
    const items = [
      { pricePaise: 20000, rating: 4.1, ratingCount: 0, etaMinutes: 30, name: "Lower" },
      { pricePaise: 20000, rating: 4.8, ratingCount: 0, etaMinutes: 30, name: "Higher" },
    ];
    const ranked = scoreOptions(items, "rating");
    expect(ranked[0]!.item.name).toBe("Higher");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("does not disturb a price-led decision", () => {
    const items = [
      { pricePaise: 10000, rating: 4.0, ratingCount: 5, etaMinutes: 30 },
      { pricePaise: 30000, rating: 4.9, ratingCount: 5000, etaMinutes: 30 },
    ];
    const ranked = scoreOptions(items, "price");
    expect(ranked[0]!.item.pricePaise).toBe(10000);
  });
});
