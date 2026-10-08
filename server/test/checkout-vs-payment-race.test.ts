import crypto from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A second checkout running while the first payment is confirmed.
//
// Checkout reads the order, sees it awaiting payment, and finishes by writing
// the payment back to "created". When the gateway confirmed the first payment
// in between (a customer tapping Pay again just as a slow payment lands), that
// write turned a successful payment back into an unpaid one on a confirmed
// order. Cancelling it then refunded nothing, because nothing looked paid.

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

describe("checkout while the payment is being confirmed", () => {
  it("never turns a successful payment back into an unpaid one", async () => {
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "dum-biryani", platform: "ondc" })
      .expect(201);
    const orderId = created.body.order.id as string;
    const amount = created.body.order.amount as number;
    await agent.post("/api/payments/checkout").send({ orderId }).expect(200);

    // Hold the second checkout's look at the order while the payment lands.
    let held = false;
    const real = prisma.order.findFirst.bind(prisma.order);
    vi.spyOn(prisma.order, "findFirst").mockImplementation((async (args: { where?: { id?: string } }) => {
      const row = await real(args as never);
      if (!held && args?.where?.id === orderId) {
        held = true;
        await new Promise((r) => setTimeout(r, 400));
      }
      return row;
    }) as never);

    const retry = agent.post("/api/payments/checkout").send({ orderId }).then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    expect((await deliver(orderId, amount / 100)).status).toBe(200);
    const retried = await retry;

    expect(held).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(order.status).toBe("confirmed");
    expect(payment.status).toBe("success");
    expect(retried.status).toBe(409);

    // And the money is owed back if the order is now cancelled.
    await agent.post(`/api/orders/${orderId}/cancel`).send({}).expect(200);
    const after = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(after.status).toBe("refund_pending");
  });
});
