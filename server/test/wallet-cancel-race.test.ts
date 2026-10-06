import { describe, expect, it, vi } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { creditCashback, walletBalance } from "../src/modules/users/wallet.service.js";

// Reward credit spent on an order comes back when the order is cancelled,
// whatever order the two requests land in.
//
// Cancelling refunded the credit recorded in the order's details. Paying with
// credit at the same moment debited the wallet and wrote that record, and the
// cancellation, holding a copy of the details read before it, wrote its copy
// back over the record and refunded nothing. The credit was simply gone.

async function setup() {
  const { agent, email } = await authedAgent();
  const me = await prisma.user.findUniqueOrThrow({ where: { email } });
  await creditCashback({ userId: me.id, orderId: "earn-race", marginPaise: 10_000 }); // 3000
  const created = await agent
    .post("/api/orders")
    .send({ domain: "food", dishId: "masala-dosa", platform: "ondc" })
    .expect(201);
  return { agent, userId: me.id, orderId: created.body.order.id as string };
}

describe("cancelling while paying with reward credit", () => {
  it("returns credit the ledger shows was spent, even if the order's record of it was lost", async () => {
    const { agent, userId, orderId } = await setup();

    // The cancel reads the order before the payment records its credit.
    const stale = await prisma.order.findFirst({ where: { id: orderId } });
    await agent.post("/api/payments/checkout").send({ orderId, useWallet: true }).expect(200);
    expect(await walletBalance(userId)).toBe(0);

    const spy = vi.spyOn(prisma.order, "findFirst").mockResolvedValueOnce(stale as never);
    try {
      await agent.post(`/api/orders/${orderId}/cancel`).send({}).expect(200);
    } finally {
      spy.mockRestore();
    }

    expect(await walletBalance(userId)).toBe(3000);
  });

  it("returns credit taken by a payment that landed after the cancellation", async () => {
    const { agent, userId, orderId } = await setup();

    // The payment read the order as awaiting payment, then the cancel won.
    const stale = await prisma.order.findFirst({ where: { id: orderId }, include: { user: true } });
    await agent.post(`/api/orders/${orderId}/cancel`).send({}).expect(200);

    const spy = vi.spyOn(prisma.order, "findFirst").mockResolvedValueOnce(stale as never);
    try {
      await agent.post("/api/payments/checkout").send({ orderId, useWallet: true });
    } finally {
      spy.mockRestore();
    }

    expect(await walletBalance(userId)).toBe(3000);
  });
});
