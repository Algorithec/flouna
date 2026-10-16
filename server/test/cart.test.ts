import request from "supertest";
import { describe, expect, it } from "vitest";
import { allQuotes } from "../src/modules/food/food.service.js";
import { prisma } from "../src/lib/prisma.js";
import { app, authedAgent } from "./helpers.js";

// The cart lives on the server, so the app and chat share one. Lines are real
// catalogue listings; what is shown is read from the catalogue each time.

const [a, b] = (() => {
  const seen = new Set<string>();
  const picks = [];
  for (const q of allQuotes()) {
    if (seen.has(q.dishId)) continue;
    seen.add(q.dishId);
    picks.push(q);
    if (picks.length === 2) break;
  }
  return picks as [ReturnType<typeof allQuotes>[number], ReturnType<typeof allQuotes>[number]];
})();

describe("cart", () => {
  it("needs a signed in customer", async () => {
    await request(app).get("/api/cart").expect(401);
    await request(app).post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform }).expect(401);
  });

  it("starts empty, then holds what was added, named and priced from the catalogue", async () => {
    const { agent } = await authedAgent();
    expect((await agent.get("/api/cart").expect(200)).body).toEqual({ lines: [], count: 0, removed: 0 });
    const res = await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform, qty: 2 }).expect(200);
    expect(res.body.count).toBe(2);
    expect(res.body.lines[0]).toMatchObject({
      dishId: a.dishId,
      platform: a.platform,
      qty: 2,
      name: a.name,
      restaurant: a.restaurant,
      pricePaise: a.basePaise,
      available: true,
      addedVia: "app",
    });
  });

  it("adds to a line already there instead of duplicating it, up to the cap", async () => {
    const { agent } = await authedAgent();
    await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform, qty: 15 }).expect(200);
    const res = await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform, qty: 10 }).expect(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].qty).toBe(20);
  });

  it("refuses a dish or listing the catalogue does not have", async () => {
    const { agent } = await authedAgent();
    await agent.post("/api/cart/items").send({ dishId: "no-such-dish", platform: a.platform }).expect(404);
    await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: "no-such-platform" }).expect(404);
    await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform, qty: 0 }).expect(400);
    await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform, pricePaise: 1 }).expect(400);
  });

  it("changes, removes and clears lines", async () => {
    const { agent } = await authedAgent();
    await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform }).expect(200);
    await agent.post("/api/cart/items").send({ dishId: b.dishId, platform: b.platform }).expect(200);
    expect((await agent.patch("/api/cart/items").send({ dishId: a.dishId, platform: a.platform, qty: 3 }).expect(200)).body.count).toBe(4);
    expect((await agent.patch("/api/cart/items").send({ dishId: a.dishId, platform: a.platform, qty: 0 }).expect(200)).body.lines).toHaveLength(1);
    expect((await agent.delete("/api/cart/items").send({ dishId: b.dishId, platform: b.platform }).expect(200)).body.count).toBe(0);
    await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform }).expect(200);
    expect((await agent.delete("/api/cart").expect(200)).body).toEqual({ lines: [], count: 0, removed: 0 });
    await agent.patch("/api/cart/items").send({ dishId: a.dishId, platform: a.platform, qty: 1 }).expect(404);
  });

  it("drops a dish that has left the catalogue and says how many, so checkout is not blocked", async () => {
    const { agent, email } = await authedAgent();
    await agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform }).expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { cart: true } });
    // As if the dish was withdrawn after it was added.
    await prisma.cartItem.create({ data: { cartId: user.cart!.id, dishId: "withdrawn-dish", platform: a.platform, qty: 1 } });
    const res = await agent.get("/api/cart").expect(200);
    expect(res.body.lines.map((l: { dishId: string }) => l.dishId)).toEqual([a.dishId]);
    expect(res.body.removed).toBe(1);
    // Gone for good, and the rest of the cart still prices.
    expect((await agent.get("/api/cart").expect(200)).body.removed).toBe(0);
    await agent.post("/api/orders/preview").send({ items: [{ dishId: a.dishId, platform: a.platform, qty: 1 }] }).expect(200);
  });

  it("keeps each customer's cart to themselves", async () => {
    const one = await authedAgent();
    const two = await authedAgent();
    await one.agent.post("/api/cart/items").send({ dishId: a.dishId, platform: a.platform }).expect(200);
    expect((await two.agent.get("/api/cart").expect(200)).body.count).toBe(0);
  });

  it("brings over a cart saved in the browser once, without doubling it if sent again", async () => {
    const { agent } = await authedAgent();
    const lines = [
      { dishId: a.dishId, platform: a.platform, qty: 2, name: "stale name", pricePaise: 1 },
      { dishId: "gone-dish", platform: a.platform, qty: 1 },
    ];
    await agent.post("/api/cart/import").send({ lines }).expect(200);
    const res = await agent.post("/api/cart/import").send({ lines }).expect(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ qty: 2, name: a.name, pricePaise: a.basePaise });
  });
});
