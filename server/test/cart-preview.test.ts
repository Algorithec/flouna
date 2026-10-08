import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { quotesForDish } from "../src/modules/food/food.service.js";

// The total on the cart screen has to be the amount charged.
//
// The screen added it up itself from the price stored when each item was added,
// which is that listing's effective price: the delivery fee included and the
// offer already off. The order route charges one delivery fee for the order and
// takes each offer off once, so from quantity two the two answers diverged and
// the screen promised a number nobody was going to charge.
//
// These tests are the comparison, through the HTTP surfaces the screen and the
// checkout actually use.

const CART = [{ dishId: "dum-biryani", platform: "ondc", qty: 2 }];

describe("the preview is the bill", () => {
  it("quotes the same total the order is created for", async () => {
    const { agent } = await authedAgent();
    const preview = await agent.post("/api/orders/preview").send({ items: CART }).expect(200);
    const order = await agent
      .post("/api/orders")
      .send({ domain: "food", items: CART })
      .expect(201);

    expect(preview.body.bill.totalPaise).toBe(order.body.order.amount);
  });

  it("agrees on every line of the bill, not only the total", async () => {
    const { agent } = await authedAgent();
    const items = [
      { dishId: "dum-biryani", platform: "ondc", qty: 2 },
      { dishId: "masala-dosa", platform: "ondc", qty: 1 },
    ];
    const bill = (await agent.post("/api/orders/preview").send({ items }).expect(200)).body.bill;
    const order = (
      await agent.post("/api/orders").send({ domain: "food", items }).expect(201)
    ).body.order;
    const d = JSON.parse(order.details);

    expect(bill.itemsTotalPaise).toBe(d.basePaise);
    expect(bill.deliveryFeePaise).toBe(d.deliveryFeePaise);
    expect(bill.convenienceFeePaise).toBe(d.convenienceFeePaise);
    expect(bill.offersDiscountPaise).toBe(
      d.offers.reduce((s: number, o: { discountPaise: number }) => s + o.discountPaise, 0),
    );
    expect(bill.savedPaise).toBe(order.savedPaise);
    expect(bill.totalPaise).toBe(order.amount);
  });

  it("differs from adding the stored prices up, which is the bug", async () => {
    // What the screen used to show. Kept as a test because the wrong answer is
    // the natural one to write: it reads per-line prices that each carry their
    // own delivery fee and their own offer.
    const { agent } = await authedAgent();
    const quote = quotesForDish("dum-biryani").find((q) => q.platform === "ondc")!;
    // The divergence needs a delivery fee or an offer to exist on this listing.
    expect(quote.deliveryFeePaise + quote.offers.length).toBeGreaterThan(0);

    const naive = quote.effectivePaise * 2;
    const bill = (await agent.post("/api/orders/preview").send({ items: CART }).expect(200)).body
      .bill;
    expect(bill.totalPaise).not.toBe(naive);
  });

  it("quotes what a single dish is charged, fee and all", async () => {
    // The dish screen reads the same preview. It used to print the dish price
    // as the total, and the order adds the convenience fee unless the customer
    // is on Plus, so the button promised less than the card was debited.
    const { agent } = await authedAgent();
    const one = [{ dishId: "masala-dosa", platform: "ondc", qty: 1 }];
    const bill = (await agent.post("/api/orders/preview").send({ items: one }).expect(200)).body
      .bill;
    const order = (
      await agent
        .post("/api/orders")
        .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
        .expect(201)
    ).body.order;

    expect(bill.totalPaise).toBe(order.amount);
    // And the fee is a real part of it, not a rounding difference.
    expect(bill.convenienceFeePaise).toBeGreaterThan(0);
  });

  it("charges one delivery fee however many lines there are", async () => {
    const { agent } = await authedAgent();
    const one = (
      await agent
        .post("/api/orders/preview")
        .send({ items: [{ dishId: "dum-biryani", platform: "ondc", qty: 1 }] })
        .expect(200)
    ).body.bill;
    const two = (
      await agent
        .post("/api/orders/preview")
        .send({
          items: [
            { dishId: "dum-biryani", platform: "ondc", qty: 1 },
            { dishId: "masala-dosa", platform: "ondc", qty: 1 },
          ],
        })
        .expect(200)
    ).body.bill;
    expect(two.deliveryFeePaise).toBeGreaterThanOrEqual(one.deliveryFeePaise);
    expect(two.deliveryFeePaise).toBeLessThan(one.deliveryFeePaise * 2 + 1);
  });

  it("prices without ordering anything", async () => {
    const { agent, email } = await authedAgent();
    const me = await prisma.user.findUniqueOrThrow({ where: { email } });
    const before = await prisma.order.count({ where: { userId: me.id } });
    await agent.post("/api/orders/preview").send({ items: CART }).expect(200);
    expect(await prisma.order.count({ where: { userId: me.id } })).toBe(before);
  });

  it("says so when an item has gone, rather than pricing without it", async () => {
    const { agent } = await authedAgent();
    await agent
      .post("/api/orders/preview")
      .send({ items: [{ dishId: "not-a-dish", platform: "ondc", qty: 1 }] })
      .expect(404);
  });

  it("refuses an unknown field instead of ignoring it", async () => {
    const { agent } = await authedAgent();
    await agent
      .post("/api/orders/preview")
      .send({ items: CART, amount: 1 })
      .expect(400);
  });

  it("is not readable without signing in", async () => {
    const { agent } = await authedAgent();
    await agent.post("/api/auth/logout").expect(200);
    await agent.post("/api/orders/preview").send({ items: CART }).expect(401);
  });
});
