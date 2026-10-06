import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// The free cancellation window starts when the customer pays.
//
// The policy promises five minutes "after payment", and the code says so. It
// measured them from the payment row's creation, and that row is created when
// checkout starts. Someone who spent ten minutes on the payment page had no
// window left at the moment they paid, which is the case the window exists to
// protect.

describe("the free cancellation window", () => {
  it("starts at payment, not when the payment page opened", async () => {
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
      .expect(201);
    const orderId = created.body.order.id as string;

    // Checkout opens, and the customer takes ten minutes to pay.
    await agent.post("/api/payments/checkout").send({ orderId }).expect(200);
    await prisma.payment.update({
      where: { orderId },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    await agent.post("/api/payments/simulate").send({ orderId, method: "upi" }).expect(200);

    const terms = await agent.get(`/api/orders/${orderId}/cancellation`).expect(200);
    expect(terms.body.freeWindow ?? terms.body.terms?.freeWindow).toBe(true);
  });

  it("is spent five minutes after payment", async () => {
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
      .expect(201);
    const orderId = created.body.order.id as string;
    await agent.post("/api/payments/checkout").send({ orderId }).expect(200);
    await agent.post("/api/payments/simulate").send({ orderId, method: "upi" }).expect(200);

    // Paid six minutes ago.
    const sixAgo = new Date(Date.now() - 6 * 60_000);
    await prisma.payment.update({ where: { orderId }, data: { createdAt: sixAgo, paidAt: sixAgo } });

    const terms = await agent.get(`/api/orders/${orderId}/cancellation`).expect(200);
    expect(terms.body.freeWindow ?? terms.body.terms?.freeWindow).toBe(false);
  });
});
