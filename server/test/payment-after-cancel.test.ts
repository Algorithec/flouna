import crypto from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Money that arrives for an order that no longer exists has to be owed back.
//
// An order waiting for payment can be cancelled while its payment page is
// still open, and a payment already in flight completes anyway. The gateway
// then reports it, and confirmation saw a cancelled order and quietly did
// nothing: the customer had paid, the order was dead, the payment row still
// said "processing", and nothing anywhere recorded that a refund was owed. Ops
// could not find it and the customer could not see it.

function signedWebhook(orderId: string, amountRupees: number) {
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
  return { body, timestamp, signature };
}

function deliver(orderId: string, amountRupees: number) {
  const { body, timestamp, signature } = signedWebhook(orderId, amountRupees);
  return request(app)
    .post("/api/payments/webhook/cashfree")
    .set("Content-Type", "application/json")
    .set("x-webhook-signature", signature)
    .set("x-webhook-timestamp", timestamp)
    .send(JSON.parse(body));
}

async function cancelledWhilePaying() {
  const { agent } = await authedAgent();
  const created = await agent
    .post("/api/orders")
    .send({ domain: "food", dishId: "dum-biryani", platform: "ondc" })
    .expect(201);
  const orderId = created.body.order.id as string;
  const amount = created.body.order.amount as number;
  // Payment starts, then the customer cancels before it completes.
  await agent.post("/api/payments/checkout").send({ orderId }).expect(200);
  await agent.post(`/api/orders/${orderId}/cancel`).send({}).expect(200);
  return { agent, orderId, amount };
}

describe("a payment that lands after the order was cancelled", () => {
  it("records the money as owed back", async () => {
    const { orderId, amount } = await cancelledWhilePaying();

    await deliver(orderId, amount / 100).expect(200);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).toBe("refund_pending");
    expect(payment.amount).toBe(amount);
  });

  it("leaves the order cancelled rather than reviving it", async () => {
    const { orderId, amount } = await cancelledWhilePaying();
    await deliver(orderId, amount / 100).expect(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("cancelled");
    // No delivery timeline for food nobody is going to cook.
    expect(await prisma.trackingEvent.count({ where: { orderId } })).toBe(0);
  });

  it("owes it once however many times the gateway repeats itself", async () => {
    // Webhooks are delivered at least once. A refund already being processed,
    // or already paid out, must not be reopened by a repeat.
    const { orderId, amount } = await cancelledWhilePaying();
    await deliver(orderId, amount / 100).expect(200);
    await prisma.payment.update({ where: { orderId }, data: { status: "refunded" } });

    await deliver(orderId, amount / 100).expect(200);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).toBe("refunded");
  });

  it("does not invent a refund for an order that was paid normally", async () => {
    // The ordinary duplicate: confirmed once, then the same webhook again.
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "dum-biryani", platform: "ondc" })
      .expect(201);
    const orderId = created.body.order.id as string;
    const amount = created.body.order.amount as number;
    await agent.post("/api/payments/checkout").send({ orderId }).expect(200);

    await deliver(orderId, amount / 100).expect(200);
    await deliver(orderId, amount / 100).expect(200);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).toBe("success");
  });
});
