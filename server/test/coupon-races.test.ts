import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A promo code's limits have to hold when two orders arrive together.
//
// Both limits were checked before the order was created and recorded after
// it, with nothing tying the two together: the per-customer rule was a lookup
// for an earlier redemption, and the usage cap a read of the count. Two orders
// placed at the same moment both passed both checks and both got the
// discount. That is money, and a double tap on a slow phone is enough.

async function makeCoupon(overrides: Record<string, unknown> = {}) {
  const code = `R${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
  return prisma.coupon.create({
    data: {
      code,
      description: "Race test code",
      kind: "flat",
      valuePaise: 5000,
      minOrderPaise: 0,
      domain: "food",
      ...overrides,
    },
  });
}

const order = (couponCode: string) => ({
  domain: "food",
  items: [{ dishId: "dum-biryani", platform: "ondc", qty: 1 }],
  couponCode,
});

describe("promo code limits under concurrent orders", () => {
  it("lets one customer use a code once, even with two orders at the same moment", async () => {
    const { agent } = await authedAgent();
    const coupon = await makeCoupon();

    // Distinct idempotency keys: two genuine orders, not one retried.
    const results = await Promise.all([
      agent.post("/api/orders").set("Idempotency-Key", "race-a").send(order(coupon.code)),
      agent.post("/api/orders").set("Idempotency-Key", "race-b").send(order(coupon.code)),
    ]);
    const discounted = results.filter((r) => r.status === 201);

    expect(discounted.length).toBe(1);
    expect(
      await prisma.couponRedemption.count({ where: { couponId: coupon.id } }),
    ).toBe(1);
    // The refused one says why, rather than failing with a 500.
    const refused = results.find((r) => r.status !== 201)!;
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/already used/i);
  });

  it("never lets a capped code be claimed past its cap", async () => {
    const coupon = await makeCoupon({ usageLimit: 1 });
    const customers = await Promise.all([authedAgent(), authedAgent(), authedAgent()]);

    const results = await Promise.all(
      customers.map(({ agent }, i) =>
        agent.post("/api/orders").set("Idempotency-Key", `cap-${i}`).send(order(coupon.code)),
      ),
    );

    expect(results.filter((r) => r.status === 201).length).toBe(1);
    const after = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(after.usedCount).toBe(1);
    expect(
      await prisma.couponRedemption.count({ where: { couponId: coupon.id } }),
    ).toBe(1);
  });

  it("creates no order at all when the code is refused at the last moment", async () => {
    // An order must never exist with a discount its code did not grant.
    const { agent, email } = await authedAgent();
    const me = await prisma.user.findUniqueOrThrow({ where: { email } });
    const coupon = await makeCoupon();

    await Promise.all([
      agent.post("/api/orders").set("Idempotency-Key", "orphan-a").send(order(coupon.code)),
      agent.post("/api/orders").set("Idempotency-Key", "orphan-b").send(order(coupon.code)),
    ]);

    const orders = await prisma.order.findMany({ where: { userId: me.id } });
    const redemptions = await prisma.couponRedemption.findMany({
      where: { couponId: coupon.id },
    });
    expect(orders.length).toBe(redemptions.length);
  });

  it("still gives a customer the discount when nothing is competing", async () => {
    const { agent } = await authedAgent();
    const coupon = await makeCoupon();
    const res = await agent.post("/api/orders").send(order(coupon.code)).expect(201);
    const d = JSON.parse(res.body.order.details);
    expect(d.coupon.discountPaise).toBe(5000);
  });
});
