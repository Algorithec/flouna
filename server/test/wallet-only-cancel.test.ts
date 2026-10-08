import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { creditCashback, walletBalance } from "../src/modules/users/wallet.service.js";

// An order paid entirely from the wallet, then cancelled.
//
// The credit goes straight back to the wallet, which is right. The payment
// row, which records a zero rupee charge, was also flagged as a refund owed
// through the gateway: the customer was told a refund was on its way that
// they had already received, and ops got a queue item whose approval asks
// Cashfree to refund nothing on an order Cashfree never saw, which fails every
// time and can never be cleared.

async function walletPaidOrder() {
  const { agent, email } = await authedAgent();
  const me = await prisma.user.findUniqueOrThrow({ where: { email } });
  await creditCashback({ userId: me.id, orderId: "earn-big", marginPaise: 200_000 }); // 60000

  const created = await agent
    .post("/api/orders")
    .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
    .expect(201);
  const orderId = created.body.order.id as string;
  const pay = await agent
    .post("/api/payments/checkout")
    .send({ orderId, useWallet: true })
    .expect(200);
  expect(pay.body.mode).toBe("wallet");
  return { agent, me, orderId };
}

describe("cancelling an order the wallet paid for in full", () => {
  it("returns the credit and owes nothing through the gateway", async () => {
    const { agent, me, orderId } = await walletPaidOrder();

    const cancel = await agent.post(`/api/orders/${orderId}/cancel`).send({}).expect(200);

    expect(cancel.body.refundPending).toBe(false);
    expect(await walletBalance(me.id)).toBe(60000);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).not.toBe("refund_pending");
  });

  it("puts nothing in the operators' refund queue", async () => {
    const { agent, orderId } = await walletPaidOrder();
    await agent.post(`/api/orders/${orderId}/cancel`).send({}).expect(200);
    expect(
      await prisma.payment.count({ where: { orderId, status: "refund_pending" } }),
    ).toBe(0);
  });
});

describe("an operator flagging a refund", () => {
  it("cannot queue a gateway refund for an order the wallet paid in full", async () => {
    const { flagRefund } = await import("../src/modules/backoffice/admin.service.js");
    const { orderId } = await walletPaidOrder();
    const result = await flagRefund(orderId);
    expect(result).toEqual({ ok: false, reason: "not_refundable" });
    expect(
      await prisma.payment.count({ where: { orderId, status: "refund_pending" } }),
    ).toBe(0);
  });
});
