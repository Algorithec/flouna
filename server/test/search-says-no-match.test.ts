import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// A search that matched nothing showed the whole menu (or the whole shop)
// under "Results", as if it had been asked for: "xyzzy" listed momos. And
// "biriyani", one letter from the dish, did the same, while the chat already
// repaired it. The search now says when it substituted, and repairs a
// misspelt dish the way the chat does.

describe("food search", () => {
  it("repairs a misspelt dish, and says what it searched for", async () => {
    const { agent } = await authedAgent();
    // Phones capitalise the first letter of a search box.
    for (const typed of ["biriyani", "Biriyani"]) {
      const res = await agent.get(`/api/food/search?q=${typed}`).expect(200);
      expect(res.body.substituted).toBe(false);
      expect(res.body.searchedFor).toBe("biryani");
      expect(res.body.quotes.length).toBeGreaterThan(0);
      for (const q of res.body.quotes) expect(q.name.toLowerCase()).toContain("biryani");
    }
  });

  it("says when nothing matched rather than listing the menu as results", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get("/api/food/search?q=xyzzyq").expect(200);
    expect(res.body.substituted).toBe(true);
    expect(res.body.searchedFor).toBeUndefined();
  });

  it("leaves a search that matched alone", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get("/api/food/search?q=pizza").expect(200);
    expect(res.body.substituted).toBe(false);
    expect(res.body.searchedFor).toBeUndefined();
    for (const q of res.body.quotes) expect(q.name.toLowerCase()).toContain("pizza");
  });
});

describe("shop search", () => {
  it("says when nothing matched", async () => {
    const { agent } = await authedAgent();
    expect((await agent.get("/api/shop/search?q=xyzzyq").expect(200)).body.substituted).toBe(true);
    expect((await agent.get("/api/shop/search?q=laptop").expect(200)).body.substituted).toBe(false);
  });
});
