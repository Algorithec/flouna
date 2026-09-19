import { describe, expect, it } from "vitest";
import {
  recommendFood,
  searchFood,
  quotesForDish,
  allQuotes,
} from "../src/modules/food/food.service.js";
import { dishes } from "../src/data/restaurants.js";

// Guards the free-text food matching an LLM feeds into recommendFood: taste
// descriptors expand to real dishes, filler words are ignored, and a vague
// query never surfaces a dessert as the top "I'm hungry" pick — while desserts
// stay fully reachable when actually asked for.

describe("food search — descriptors & fillers", () => {
  it("maps taste words to sensible dishes (never a dessert for 'spicy')", () => {
    for (const item of ["spicy", "something spicy", "spicy vegetarian dish"]) {
      const rec = recommendFood({ query: item, dietary: "veg", priority: "balanced" });
      expect(rec).toBeTruthy();
      expect(rec!.best.name.toLowerCase()).not.toContain("cake");
    }
    expect(recommendFood({ query: "healthy", priority: "balanced" })!.best.name)
      .toMatch(/bowl|salad|quinoa/i);
  });

  it("keeps a specific dish request specific — 'I want pizza' returns pizza (regression)", () => {
    // The chat searches on the LLM item PLUS the raw sentence, so a real query
    // is "pizza I want pizza". The stray one-letter "i" from "I" used to match
    // almost every dish (it's inside "ice cream", "italian", "biryani"…),
    // widening the search to the whole menu so the top-rated dish (cake) won.
    for (const q of ["pizza I want pizza", "I want pizza", "get me a pizza"]) {
      const rec = recommendFood({ query: q, priority: "balanced" });
      expect(rec).toBeTruthy();
      expect(rec!.best.name.toLowerCase()).toContain("pizza");
    }
    // A bare one-letter token ("i") is treated as filler — it must not match
    // dishes by letters-inside-a-word, so it can't surface a dessert as the
    // top pick the way it used to.
    const lone = recommendFood({ query: "i", priority: "balanced" });
    expect(lone!.best.name.toLowerCase()).not.toContain("cake");
  });

  it("strips generic filler items ('popular dishes', 'food') and skips desserts", () => {
    for (const item of ["popular dishes", "food", "something to eat", "i'm hungry"]) {
      const rec = recommendFood({ query: item, priority: "balanced" });
      expect(rec).toBeTruthy();
      // A vague 'hungry' query must not top-pick a dessert.
      expect(rec!.best.name.toLowerCase()).not.toContain("cake");
    }
  });

  it("still reaches desserts when explicitly asked", () => {
    for (const item of ["something sweet", "cake", "dessert"]) {
      const rec = recommendFood({ query: item, priority: "balanced" });
      expect(rec!.best.name.toLowerCase()).toContain("cake");
    }
  });

  it("a filler word combined with a real descriptor keeps the descriptor", () => {
    const rec = recommendFood({ query: "popular spicy dishes", dietary: "veg", priority: "balanced" });
    expect(rec!.best.name.toLowerCase()).not.toContain("cake");
  });

  it("quotesForDish resolves any dish by id, desserts included", () => {
    const cake = quotesForDish("chocolate-cake");
    expect(cake.length).toBeGreaterThan(0);
    expect(cake[0]!.name.toLowerCase()).toContain("cake");
    // sorted cheapest-first
    for (let i = 1; i < cake.length; i++) {
      expect(cake[i]!.effectivePaise).toBeGreaterThanOrEqual(cake[i - 1]!.effectivePaise);
    }
    expect(quotesForDish("no-such-dish")).toEqual([]);
  });

  it("allQuotes covers the whole catalog including desserts (for feed stats)", () => {
    const all = allQuotes();
    expect(all.some((q) => q.name.toLowerCase().includes("cake"))).toBe(true);
    // searchFood('') deliberately excludes desserts — the two must differ.
    const searchEmpty = searchFood({ query: "" });
    expect(all.length).toBeGreaterThan(searchEmpty.length);
    expect(searchEmpty.some((q) => q.name.toLowerCase().includes("cake"))).toBe(false);
  });
});

// The saving a recommendation claims has to be a saving that exists.
//
// It was measured against the cheapest option in the whole result set, and the
// pick comes from that same set, so the difference could only ever be zero or
// negative. Both messages were unreachable: across 2,420 searches covering
// every dish, priority, budget and dietary combination, neither line appeared
// once, including on the 387 where the pick really was dearer than something
// on screen. The comparison belongs across platforms for one dish, which is
// what the comment always claimed it was and what the savings ledger counts.
describe("the saving a pick claims", () => {
  it("is reachable at all", () => {
    const seen = dishes.flatMap((d) => [d.name, ...(d.keywords ?? [])]);
    const claims = seen
      .map((q) => recommendFood({ query: q, priority: "price" }))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .filter((r) => /you save ₹/.test(r.why));
    expect(claims.length).toBeGreaterThan(0);
  });

  it("never claims more than the same dish actually costs elsewhere", () => {
    const terms = dishes.flatMap((d) => [d.name, ...(d.keywords ?? [])]);
    for (const query of terms) {
      for (const priority of ["price", "balanced"] as const) {
        const rec = recommendFood({ query, priority });
        if (!rec) continue;
        const claimed = rec.why.match(/₹(\d+)/);
        if (!/you save ₹|cheaper than the next/.test(rec.why) || !claimed) continue;

        // Something else must carry this dish at a price high enough to
        // justify the figure, or the claim is invented.
        const elsewhere = rec.alternatives.filter(
          (a) => a.dishId === rec.best.dishId && a.platform !== rec.best.platform,
        );
        const gap = Math.max(
          0,
          ...elsewhere.map((a) => a.effectivePaise - rec.best.effectivePaise),
        );
        // Rounded to rupees in the message, so allow the rounding itself.
        expect(Number(claimed[1]) * 100).toBeLessThanOrEqual(gap + 100);
      }
    }
  });
});
