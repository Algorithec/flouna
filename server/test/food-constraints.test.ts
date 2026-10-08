import { describe, expect, it } from "vitest";
import {
  allQuotes,
  recommendFood,
  searchFoodTraced,
} from "../src/modules/food/food.service.js";

// Stated limits applied to real food quotes, and how they sit alongside the
// Budget Guardian's weekly allowance.
//
// Two ceilings with opposite rules share this path. A price the customer
// stated is enforced. The weekly allowance is advice and is waived rather
// than leave nothing to show. The tests at the bottom are the ones that
// matter most, because mixing the two up fails in either direction: a broken
// promise, or a customer near the end of their week refused every search.

const query = "biryani";
const priced = () => searchFoodTraced({ query }).quotes;

describe("no stated limit changes nothing", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", {}],
  ])("returns the same options when the limit is %s", (_, constraints) => {
    const plain = searchFoodTraced({ query });
    const none = searchFoodTraced({ query, constraints });
    expect(none.quotes.map((q) => q.dishId + q.platform)).toEqual(
      plain.quotes.map((q) => q.dishId + q.platform),
    );
    expect(none.unmet).toBeNull();
  });
});

describe("a stated maximum price", () => {
  it("removes every dearer option, whatever the priority", () => {
    const prices = priced().map((q) => q.effectivePaise).sort((a, b) => a - b);
    const limit = prices[Math.floor(prices.length / 2)]!;
    for (const priority of ["balanced", "price", "rating", "speed"] as const) {
      const rec = recommendFood({ query, priority, constraints: { maxPricePaise: limit } });
      expect(rec).not.toBeNull();
      expect(rec!.best.effectivePaise).toBeLessThanOrEqual(limit);
      for (const a of rec!.alternatives) expect(a.effectivePaise).toBeLessThanOrEqual(limit);
    }
  });

  it("records the removals under max_price", () => {
    const cheapest = Math.min(...priced().map((q) => q.effectivePaise));
    const r = searchFoodTraced({ query, constraints: { maxPricePaise: cheapest } });
    expect(r.exclusions.find((e) => e.rule === "max_price")?.count).toBe(
      priced().length - r.quotes.length,
    );
  });

  it("is not waived when nothing fits, unlike the weekly budget", () => {
    const cheapest = Math.min(...priced().map((q) => q.effectivePaise));
    const stated = searchFoodTraced({ query, constraints: { maxPricePaise: cheapest - 100 } });
    const weekly = searchFoodTraced({ query, budgetPaise: cheapest - 100 });

    expect(stated.quotes).toEqual([]);
    // The same number as advice is still waived, exactly as before.
    expect(weekly.quotes.length).toBeGreaterThan(0);
    expect(weekly.exclusions.some((e) => e.rule === "budget_ceiling_waived")).toBe(true);
  });
});

describe("a latest delivery time", () => {
  it("removes every slower delivery", () => {
    const etas = priced().map((q) => q.etaMinutes).sort((a, b) => a - b);
    const limit = etas[Math.floor(etas.length / 2)]!;
    const r = searchFoodTraced({ query, constraints: { maxEtaMinutes: limit } });
    expect(r.quotes.length).toBeGreaterThan(0);
    for (const q of r.quotes) expect(q.etaMinutes).toBeLessThanOrEqual(limit);
    expect(r.exclusions.some((e) => e.rule === "max_eta")).toBe(true);
  });

  it("ignores a pickup limit, because food has no pickup", () => {
    // A combo request carries a ride's pickup limit alongside the food. It
    // must not reach the food results and empty them.
    const r = searchFoodTraced({ query, constraints: { maxPickupMinutes: 1 } });
    expect(r.quotes.length).toBe(priced().length);
  });
});

describe("when a stated limit rules out everything", () => {
  it("recommends nothing rather than something over the limit", () => {
    const cheapest = Math.min(...priced().map((q) => q.effectivePaise));
    expect(recommendFood({ query, constraints: { maxPricePaise: cheapest - 100 } })).toBeNull();
  });

  it("names the nearest option so the customer can be told what exists", () => {
    const cheapest = Math.min(...priced().map((q) => q.effectivePaise));
    const r = searchFoodTraced({ query, constraints: { maxPricePaise: cheapest - 100 } });
    expect(r.unmet?.rule).toBe("max_price");
    expect(r.unmet?.item.effectivePaise).toBe(cheapest);
    expect(r.unmet?.by).toBe(100);
  });
});

describe("a stated limit and the weekly allowance together", () => {
  it("lets the allowance choose among valid options without readmitting invalid ones", () => {
    // Stated: under the median price. Weekly allowance: far below anything,
    // so it has to waive. It may give up on itself; it may not give up on
    // what the customer said.
    const prices = priced().map((q) => q.effectivePaise).sort((a, b) => a - b);
    const stated = prices[Math.floor(prices.length / 2)]!;
    const r = searchFoodTraced({
      query,
      budgetPaise: 1,
      constraints: { maxPricePaise: stated },
    });

    expect(r.quotes.length).toBeGreaterThan(0);
    for (const q of r.quotes) expect(q.effectivePaise).toBeLessThanOrEqual(stated);
    expect(r.exclusions.some((e) => e.rule === "budget_ceiling_waived")).toBe(true);
    expect(r.exclusions.some((e) => e.rule === "max_price")).toBe(true);
  });

  it("still narrows to the allowance when something valid fits it", () => {
    const prices = priced().map((q) => q.effectivePaise).sort((a, b) => a - b);
    const stated = prices[prices.length - 1]!;
    const weekly = prices[0]!;
    const r = searchFoodTraced({
      query,
      budgetPaise: weekly,
      constraints: { maxPricePaise: stated },
    });
    for (const q of r.quotes) expect(q.effectivePaise).toBeLessThanOrEqual(weekly);
  });
});

describe("across the whole catalogue", () => {
  it("never returns anything over a stated price, for any search", () => {
    const every = allQuotes().map((q) => q.effectivePaise).sort((a, b) => a - b);
    const limits = [every[0]!, every[Math.floor(every.length / 3)]!, every[Math.floor(every.length / 2)]!];
    const searches = ["", "hungry", "biryani", "pizza", "dosa", "spicy", "healthy", "sweet"];
    let checked = 0;
    for (const q of searches) for (const limit of limits) for (const budgetPaise of [null, 1, limit]) {
      const r = searchFoodTraced({ query: q, budgetPaise, constraints: { maxPricePaise: limit } });
      for (const quote of r.quotes) {
        expect(quote.effectivePaise).toBeLessThanOrEqual(limit);
        checked++;
      }
    }
    // Not vacuous: there must have been real options to check.
    expect(checked).toBeGreaterThan(20);
  });
});
