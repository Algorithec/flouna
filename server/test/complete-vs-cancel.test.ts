import { describe, expect, it, vi } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { walletBalance } from "../src/modules/users/wallet.service.js";

// A cancellation is not undone by the order screen polling.
//
// Viewing an order completes it once its timeline has run out, and that write
// was unconditional: the order was read as confirmed, then set to completed
// whatever had happened since. A customer cancelling at that moment had their
// cancellation overwritten, leaving an order marked completed with a refund
// flagged against it and cashback paid on it.

async function paidOrderWithElapsedTimeline() {
  const { agent, email } = await authedAgent();
  const created = await agent
    .post("/api/orders")
    .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
    .expect(201);
  const orderId = created.body.order.id as string;
  await agent.post("/api/payments/checkout").send({ orderId }).expect(200);
  await agent.post("/api/payments/simulate").send({ orderId, method: "upi" }).expect(200);
  // Every tracking step is in the past, so the next view completes it.
  await prisma.trackingEvent.updateMany({
    where: { orderId },
    data: { createdAt: new Date(Date.now() - 60 * 60_000) },
  });
  const me = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { agent, orderId, userId: me.id };
}

describe("completing an order that was just cancelled", () => {
  it("leaves the cancellation in place", async () => {
    const { agent, orderId, userId } = await paidOrderWithElapsedTimeline();

    // The view reads the order as confirmed; the cancellation lands before
    // its write. Forced by handing the view a copy read a moment earlier.
    const stale = await prisma.order.findFirst({
      where: { id: orderId },
      include: {
        trackingEvents: { orderBy: { createdAt: "asc" } },
        payment: { select: { status: true, method: true, gatewayOrderId: true } },
        rating: { select: { stars: true, comment: true } },
      },
    });
    await prisma.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
    const spy = vi.spyOn(prisma.order, "findFirst").mockResolvedValueOnce(stale as never);
    try {
      await agent.get(`/api/orders/${orderId}`).expect(200);
    } finally {
      spy.mockRestore();
    }

    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.status).toBe("cancelled");
    expect(await walletBalance(userId)).toBe(0);
  });

  it("still completes an order nobody cancelled", async () => {
    const { agent, orderId, userId } = await paidOrderWithElapsedTimeline();
    const res = await agent.get(`/api/orders/${orderId}`).expect(200);
    expect(res.body.order.status).toBe("completed");
    expect(await walletBalance(userId)).toBeGreaterThan(0);
  });
});
