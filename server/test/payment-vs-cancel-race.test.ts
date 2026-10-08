import crypto from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A payment and a cancellation landing at the same moment.
//
// Confirmation reads the order, sees it still waiting for payment, and then
// claims it. A cancellation that lands between the read and the claim leaves
// the claim nothing to take, and confirmation used to stop there: the gateway
// had the customer's money, the order was cancelled, and no refund was owed
// anywhere. The sequential case was already handled; this is the same money
// lost to timing.

function deliver(orderId: string, amountRupees: number) {
  const body = JSON.stringify({
    type: "PAYMENT_SUCCESS_WEBHOOK",
    data: {
      order: { order_id: orderId, order_amount: amountRupees },
      payment: { payment_status: "SUCCESS", payment_group: "upi", payment_amount: amountRupees },
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", process.env.CASHFREE_SECRET_KEY!)
    .update(timestamp + body)
    .digest("base64");
  return request(app)
    .post("/api/payments/webhook/cashfree")
    .set("Content-Type", "application/json")
    .set("x-webhook-signature", signature)
    .set("x-webhook-timestamp", timestamp)
    .send(JSON.parse(body));
}

afterEach(() => vi.restoreAllMocks());

describe("a payment confirmed while the order is being cancelled", () => {
  it("owes the money back instead of losing it", async () => {
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "dum-biryani", platform: "ondc" })
      .expect(201);
    const orderId = created.body.order.id as string;
    const amount = created.body.order.amount as number;
    await agent.post("/api/payments/checkout").send({ orderId }).expect(200);

    // Hold the payment's first look at the order long enough for the
    // cancellation to land, which is the window a real one can fall into.
    let held = false;
    const real = prisma.order.findUnique.bind(prisma.order);
    vi.spyOn(prisma.order, "findUnique").mockImplementation((async (args: { where: { id?: string } }) => {
      const row = await real(args as never);
      if (!held && args.where.id === orderId) {
        held = true;
        await new Promise((r) => setTimeout(r, 400));
      }
      return row;
    }) as never);

    // supertest sends only once awaited, so start it now.
    const paying = deliver(orderId, amount / 100).then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    await agent.post(`/api/orders/${orderId}/cancel`).send({}).expect(200);
    expect((await paying).status).toBe(200);

    expect(held).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(order.status).toBe("cancelled");
    expect(payment.status).toBe("refund_pending");
    expect(payment.amount).toBe(amount);
  });
});
