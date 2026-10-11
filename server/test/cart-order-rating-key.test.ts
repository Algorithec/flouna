import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { communityRatings } from "../src/modules/ratings/ratings.service.js";

// Community ratings for food are keyed by dish. A cart order stores its lines
// under `items` and carries no top-level dishId, so rating one filed the stars
// against the platform name instead — a key nothing ever looks up.
//
// The rating was accepted, shown back to the customer, counted nowhere. On the
// orders most likely to be rated, the only feedback loop the ranking has was
// quietly open at both ends.

type Agent = Awaited<ReturnType<typeof authedAgent>>["agent"];

async function completedCartOrder(agent: Agent, dishId: string) {
  const placed = await agent
    .post("/api/orders")
    .send({
      domain: "food",
      items: [
        { dishId, platform: "ondc", qty: 2 },
        { dishId: "masala-dosa", platform: "ondc", qty: 1 },
      ],
    })
    .expect(201);
  const orderId = placed.body.order.id as string;
  await agent
    .post("/api/payments/simulate")
    .send({ orderId, method: "upi" })
    .expect(200);
  await prisma.trackingEvent.updateMany({
    where: { orderId },
    data: { createdAt: new Date(Date.now() - 60_000) },
  });
  await prisma.order.update({
    where: { id: orderId },
    data: { status: "completed" },
  });
  return orderId;
}

describe("rating a multi-item cart order", () => {
  it("files the stars against a dish, not the platform name", async () => {
    const { agent } = await authedAgent();
    const orderId = await completedCartOrder(agent, "dum-biryani");

    await agent
      .post(`/api/orders/${orderId}/rate`)
      .send({ stars: 1, comment: "cold" })
      .expect(201);

    const row = await prisma.orderRating.findUniqueOrThrow({
      where: { orderId },
      select: { itemKey: true, domain: true },
    });
    expect(row.itemKey).toBe("dum-biryani");
    expect(row.itemKey).not.toBe("ondc");

    // And it is now reachable by the lookup the ranking actually makes.
    const found = await communityRatings("food", ["dum-biryani"]);
    expect(found.get("dum-biryani")?.count).toBeGreaterThan(0);
  });

  it("still keys a single-dish order by its dish", async () => {
    const { agent } = await authedAgent();
    const placed = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
      .expect(201);
    const orderId = placed.body.order.id as string;
    await agent
      .post("/api/payments/simulate")
      .send({ orderId, method: "upi" })
      .expect(200);
    await prisma.trackingEvent.updateMany({
      where: { orderId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "completed" },
    });

    await agent.post(`/api/orders/${orderId}/rate`).send({ stars: 5 }).expect(201);
    const row = await prisma.orderRating.findUniqueOrThrow({
      where: { orderId },
      select: { itemKey: true },
    });
    expect(row.itemKey).toBe("masala-dosa");
  });
});
