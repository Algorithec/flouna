import { describe, expect, it } from "vitest";
import { searchFood } from "../src/modules/food/food.service.js";

// A named dish is that dish. "Chicken biryani" shares "chicken" with half the
// menu, and those partial matches used to sit in the candidate list beside the
// biryanis, where a favourites bonus could lift a customer's usual momos above
// the biryani they asked for.

describe("searching for a named dish", () => {
  it("keeps only dishes that match the specific part of the name", () => {
    const names = searchFood({ query: "chicken biryani" }).map((q) => q.name.toLowerCase());
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.includes("biryani"))).toBe(true);
  });

  it("keeps the same answer for a one word search", () => {
    const chicken = searchFood({ query: "chicken" });
    expect(chicken.length).toBeGreaterThan(1);
    expect(new Set(chicken.map((q) => q.name)).size).toBeGreaterThan(1);
  });

  it("still finds something when no dish matches every word", () => {
    expect(searchFood({ query: "chicken sushi" }).length).toBeGreaterThan(0);
  });
});
