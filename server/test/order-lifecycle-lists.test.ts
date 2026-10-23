import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { walletBalance } from "../src/modules/users/wallet.service.js";
import { greet } from "../src/modules/support/support.bot.js";

// An order finishes when its timeline runs out, whoever is looking.
//
// Only the order screen completed an order. One whose screen was closed before
// its last step stayed "confirmed" for good: the history listed it as still
// going and left it out of "Completed", and the support assistant greeted the
// customer weeks later with an order "being prepared". The history's totals
// were also added up from the list, which stops at fifty orders.

async function paidOrder() {
  const { agent, email } = await authedAgent();
  const created = await agent
    .post("/api/orders")
    .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
    .expect(201);
  const orderId = created.body.order.id as string;
  await agent.post("/api/payments/checkout").send({ orderId }).expect(200);
  await agent.post("/api/payments/simulate").send({ orderId, method: "upi" }).expect(200);
  const me = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { agent, orderId, userId: me.id };
}

// Every tracking step in the past, as if it was delivered an hour ago.
async function deliveredAnHourAgo(orderId: string) {
  await prisma.trackingEvent.updateMany({
    where: { orderId },
    data: { createdAt: new Date(Date.now() - 60 * 60_000) },
  });
}

const statusIn = (orders: { id: string; status: string }[], id: string) =>
  orders.find((o) => o.id === id)?.status;

describe("an order whose timeline has run out", () => {
  it("is listed as completed without its screen being opened, and earns its cashback once", async () => {
    const { agent, orderId, userId } = await paidOrder();
    await deliveredAnHourAgo(orderId);

    const res = await agent.get("/api/orders").expect(200);
    expect(statusIn(res.body.orders, orderId)).toBe("completed");
    expect(res.body.stats.completed).toBe(1);
    const earned = await walletBalance(userId);
    expect(earned).toBeGreaterThan(0);

    // Listing again, then opening the order, pays nothing more.
    await agent.get("/api/orders").expect(200);
    const opened = await agent.get(`/api/orders/${orderId}`).expect(200);
    expect(opened.body.order.status).toBe("completed");
    expect(await walletBalance(userId)).toBe(earned);
  });

  it("is still under way while its timeline runs", async () => {
    const { agent, orderId, userId } = await paidOrder();
    const res = await agent.get("/api/orders").expect(200);
    expect(statusIn(res.body.orders, orderId)).toBe("confirmed");
    expect(res.body.stats.completed).toBe(0);
    expect(await walletBalance(userId)).toBe(0);
  });

  it("is not greeted as live by the support assistant", async () => {
    const { orderId, userId } = await paidOrder();
    // While it is under way the assistant does see it.
    expect((await greet(userId)).body).toMatch(/live order/);

    await deliveredAnHourAgo(orderId);
    expect((await greet(userId)).body).not.toMatch(/live order/);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.status).toBe("completed");
  });
});

describe("the history's totals", () => {
  it("count every order, not just the fifty listed, and money only where it was spent", async () => {
    const { agent, email } = await authedAgent();
    const me = await prisma.user.findUniqueOrThrow({ where: { email } });
    const order = (status: string) => ({
      userId: me.id,
      domain: "food",
      status,
      provider: "ondc",
      fulfillment: "in_app",
      title: "Masala Dosa at Udupi Grand",
      details: "{}",
      amount: 10_000,
      savedPaise: 500,
    });
    await prisma.order.createMany({
      data: [
        ...Array.from({ length: 52 }, () => order("completed")),
        ...Array.from({ length: 3 }, () => order("pending_payment")),
        ...Array.from({ length: 2 }, () => order("cancelled")),
      ],
    });

    const res = await agent.get("/api/orders").expect(200);
    expect(res.body.orders).toHaveLength(50);
    expect(res.body.stats).toEqual({
      total: 57,
      completed: 52,
      spentPaise: 52 * 10_000,
      savedPaise: 52 * 500,
    });

    // A tab's totals are that tab's.
    const rides = await agent.get("/api/orders?domain=ride").expect(200);
    expect(rides.body.stats).toEqual({ total: 0, completed: 0, spentPaise: 0, savedPaise: 0 });
  });
});
