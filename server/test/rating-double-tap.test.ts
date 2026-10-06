import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Rating an order twice at once is answered, not crashed on.
//
// One rating per order is enforced by a unique index, so the data was always
// right. The second of two simultaneous submissions hit that index and came
// back as a 500, which put a false alarm in the error log each time.

describe("rating an order with a double tap", () => {
  it("keeps one rating and tells the second tap it is already rated", async () => {
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
      .expect(201);
    const orderId = created.body.order.id as string;
    await prisma.order.update({ where: { id: orderId }, data: { status: "completed" } });

    const results = await Promise.all([
      agent.post(`/api/orders/${orderId}/rate`).send({ stars: 5 }),
      agent.post(`/api/orders/${orderId}/rate`).send({ stars: 4 }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.orderRating.count({ where: { orderId } })).toBe(1);
  });
});
