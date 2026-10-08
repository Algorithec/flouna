import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { walletBalance, creditCashback } from "../src/modules/users/wallet.service.js";

// Spending reward credit at checkout.
//
// The wallet is a payment instrument here, not a discount: the order keeps its
// gross amount and the wallet covers part of it. These tests are written as the
// ways that arrangement loses money — spending twice on a retry, confirming an
// order for less than it costs, stranding credit on a cancelled order, and
// sending a zero-rupee order to a gateway that would reject it.

async function userId(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return u.id;
}

/** A real food order, priced by the server. */
async function placeOrder(agent: Awaited<ReturnType<typeof authedAgent>>["agent"]) {
  const res = await agent
    .post("/api/orders")
    .send({ domain: "food", items: [{ dishId: "dum-biryani", platform: "ondc", qty: 1 }] })
    .expect(201);
  return res.body.order as { id: string; amount: number };
}

describe("rewards wallet at checkout", () => {
  it("leaves the balance alone when the buyer does not ask for it", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 }); // 3000

    const order = await placeOrder(agent);
    const res = await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id })
      .expect(200);

    expect(res.body.amount).toBe(order.amount);
    expect(await walletBalance(id)).toBe(3000);
  });

  it("applies the balance and asks the gateway only for the rest", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 }); // 3000

    const order = await placeOrder(agent);
    const res = await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);

    expect(res.body.walletAppliedPaise).toBe(3000);
    expect(res.body.amount).toBe(order.amount - 3000);
    expect(await walletBalance(id)).toBe(0);

    // The bill itself is untouched — the receipt still says what the food cost.
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.amount).toBe(order.amount);

    // The payment row records what the gateway handles, not the gross.
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(payment.amount).toBe(order.amount - 3000);
  });

  it("does not spend twice when checkout is retried", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 });

    const order = await placeOrder(agent);
    const first = await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);

    // A failed gateway attempt sends the buyer back here. The credit already
    // committed must be reused, never charged again.
    const second = await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);

    expect(second.body.walletAppliedPaise).toBe(first.body.walletAppliedPaise);
    expect(second.body.amount).toBe(first.body.amount);
    expect(await walletBalance(id)).toBe(0);
    const spends = await prisma.walletEntry.count({
      where: { userId: id, orderId: order.id, reason: "spend" },
    });
    expect(spends).toBe(1);
  });

  it("cannot be un-applied by simply omitting the flag on a retry", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 });

    const order = await placeOrder(agent);
    await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);

    // Credit is committed to the order. Dropping the flag must not quietly
    // restore the balance while the order still carries the reduced amount.
    const res = await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id })
      .expect(200);
    expect(res.body.amount).toBe(order.amount - 3000);
    expect(await walletBalance(id)).toBe(0);
  });

  it("takes only what is there when the balance is short of the bill", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 100 }); // 30

    const order = await placeOrder(agent);
    const res = await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);

    expect(res.body.walletAppliedPaise).toBe(30);
    expect(res.body.amount).toBe(order.amount - 30);
    expect(await walletBalance(id)).toBe(0);
  });

  it("confirms the order outright when rewards cover it in full", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    const order = await placeOrder(agent);
    // Enough to cover the whole bill. A gateway would reject a zero-rupee
    // order, so this path must never reach one.
    await prisma.walletEntry.create({
      data: {
        userId: id,
        orderId: "grant",
        amountPaise: order.amount + 5000,
        reason: "adjustment",
        description: "test grant",
      },
    });

    const res = await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);

    expect(res.body.mode).toBe("wallet");
    expect(res.body.amount).toBe(0);
    expect(res.body.walletAppliedPaise).toBe(order.amount);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("confirmed");
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(payment.status).toBe("success");
    expect(payment.method).toBe("wallet");
    expect(await walletBalance(id)).toBe(5000);
  });

  it("confirms a part-wallet order paid the rest by cash", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 });

    const order = await placeOrder(agent);
    const res = await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, method: "cash", useWallet: true })
      .expect(200);

    // Only the uncovered part is collected at the door.
    expect(res.body.mode).toBe("cash");
    expect(res.body.amount).toBe(order.amount - 3000);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("confirmed");
    expect(await walletBalance(id)).toBe(0);
  });

  it("does not confirm a simulated payment for less than the reduced bill", async () => {
    // The integrity check in markPaid has to compare against what was actually
    // owed after the wallet, or every part-wallet order would be rejected as a
    // short payment. Proven by the happy path completing.
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 });

    const order = await placeOrder(agent);
    await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);
    await agent
      .post("/api/payments/simulate")
      .send({ orderId: order.id, method: "upi" })
      .expect(200);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("confirmed");
  });

  it("returns the credit when the order is cancelled", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 });

    const order = await placeOrder(agent);
    await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);
    expect(await walletBalance(id)).toBe(0);

    await agent.post(`/api/orders/${order.id}/cancel`).send({}).expect(200);
    expect(await walletBalance(id)).toBe(3000);

    const entries = await prisma.walletEntry.findMany({
      where: { userId: id, orderId: order.id },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.map((e) => e.reason)).toEqual(["spend", "refund"]);
  });

  it("reports the balance on a pending order and withholds it once confirmed", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 });

    const order = await placeOrder(agent);
    const pending = await agent.get(`/api/payments/status/${order.id}`).expect(200);
    expect(pending.body.walletBalancePaise).toBe(3000);
    expect(pending.body.payablePaise).toBe(order.amount);
    expect(pending.body.walletAppliedPaise).toBe(0);

    await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(200);
    await agent
      .post("/api/payments/simulate")
      .send({ orderId: order.id, method: "upi" })
      .expect(200);

    const done = await agent.get(`/api/payments/status/${order.id}`).expect(200);
    expect(done.body.walletAppliedPaise).toBe(3000);
    expect(done.body.payablePaise).toBe(order.amount - 3000);
    expect(done.body.walletBalancePaise).toBe(0);
  });

  it("stacks with a promo code: the code comes off first, rewards cover the rest", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 });

    const plain = await placeOrder(agent);
    const coupon = await prisma.coupon.create({
      data: {
        code: `WALLET${Date.now().toString().slice(-6)}`,
        description: "Test code",
        domain: "food",
        kind: "flat",
        valuePaise: 2000,
        minOrderPaise: 0,
        active: true,
      },
    });
    const res = await agent
      .post("/api/orders")
      .send({
        domain: "food",
        items: [{ dishId: "dum-biryani", platform: "ondc", qty: 1 }],
        couponCode: coupon.code,
      })
      .expect(201);
    const discounted = res.body.order as { id: string; amount: number };

    // The code has already reduced the bill before the wallet sees it.
    expect(discounted.amount).toBe(plain.amount - 2000);

    const checkout = await agent
      .post("/api/payments/checkout")
      .send({ orderId: discounted.id, useWallet: true })
      .expect(200);
    expect(checkout.body.walletAppliedPaise).toBe(3000);
    expect(checkout.body.amount).toBe(discounted.amount - 3000);
    expect(await walletBalance(id)).toBe(0);
  });

  it("refuses to spend on an order that is no longer awaiting payment", async () => {
    const { agent, email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn", marginPaise: 10_000 });

    const order = await placeOrder(agent);
    await agent
      .post("/api/payments/simulate")
      .send({ orderId: order.id, method: "upi" })
      .expect(200);

    await agent
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(409);
    expect(await walletBalance(id)).toBe(3000);
  });

  it("cannot spend another account's balance", async () => {
    const { agent: mine, email: myEmail } = await authedAgent();
    const { agent: theirs } = await authedAgent();
    const myId = await userId(myEmail);
    await creditCashback({ userId: myId, orderId: "earn", marginPaise: 10_000 });

    const order = await placeOrder(mine);
    // Someone else's session naming my order gets nothing back and takes
    // nothing from me.
    await theirs
      .post("/api/payments/checkout")
      .send({ orderId: order.id, useWallet: true })
      .expect(404);
    expect(await walletBalance(myId)).toBe(3000);
  });
});

// Two spends of the same rupees.
//
// Production is Postgres at read committed. Two checkouts for different orders
// each summed the same balance, neither saw the other's uncommitted debit, and
// both committed: against a real Postgres, 39 of 40 such pairs spent ₹100
// twice and left the wallet at minus ₹100. SQLite, which this suite runs on,
// only ever admits one writer, so it cannot show that race; the Postgres run
// is the proof, and these pin the parts that prevent it.
describe("the wallet cannot be spent twice", () => {
  it("asks the database for a serializable spend", async () => {
    // The whole fix is this level plus the retry. Read committed is what let
    // both debits through, so the level is asserted rather than trusted.
    const { vi } = await import("vitest");
    const { spendFromWallet } = await import("../src/modules/users/wallet.service.js");
    const { email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn-level", marginPaise: 10_000 });

    const spy = vi.spyOn(prisma, "$transaction");
    try {
      await spendFromWallet({ userId: id, orderId: "order-level", maxPaise: 1000 });
      const opts = spy.mock.calls.at(-1)?.[1] as { isolationLevel?: string } | undefined;
      expect(opts?.isolationLevel).toBe("Serializable");
    } finally {
      spy.mockRestore();
    }
  });

  it("retries a spend the database refused, instead of failing the checkout", async () => {
    // Serializable works by aborting one of two conflicting transactions. That
    // abort (P2034) is the mechanism doing its job, and the retry is what then
    // takes only what is left.
    const { vi } = await import("vitest");
    const { spendFromWallet } = await import("../src/modules/users/wallet.service.js");
    const { email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn-retry", marginPaise: 10_000 }); // 3000

    const real = prisma.$transaction.bind(prisma);
    let calls = 0;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, opts: unknown) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(Object.assign(new Error("write conflict"), { code: "P2034" }));
      }
      return (real as (a: unknown, b: unknown) => Promise<unknown>)(fn, opts);
    }) as typeof prisma.$transaction);
    try {
      const took = await spendFromWallet({ userId: id, orderId: "order-retry", maxPaise: 5000 });
      expect(took).toBe(3000);
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(await walletBalance(id)).toBe(0);
  });

  it("returns the first debit when the same order spends again", async () => {
    // A retried checkout, or one that crashed after debiting and before
    // writing the amount onto the order. It used to hit the unique index and
    // fail with a 500 every time after, so that order could never be paid.
    const { spendFromWallet } = await import("../src/modules/users/wallet.service.js");
    const { email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn-again", marginPaise: 10_000 }); // 3000

    const first = await spendFromWallet({ userId: id, orderId: "order-again", maxPaise: 2000 });
    const second = await spendFromWallet({ userId: id, orderId: "order-again", maxPaise: 2000 });

    expect(first).toBe(2000);
    expect(second).toBe(2000);
    expect(await walletBalance(id)).toBe(1000);
    const debits = await prisma.walletEntry.count({
      where: { userId: id, orderId: "order-again", reason: "spend" },
    });
    expect(debits).toBe(1);
  });

  it("never lets spends across orders exceed the balance", async () => {
    const { spendFromWallet } = await import("../src/modules/users/wallet.service.js");
    const { email } = await authedAgent();
    const id = await userId(email);
    await creditCashback({ userId: id, orderId: "earn-many", marginPaise: 10_000 }); // 3000

    const taken = await Promise.all(
      ["o1", "o2", "o3", "o4"].map((o) =>
        spendFromWallet({ userId: id, orderId: `many-${o}`, maxPaise: 3000 }),
      ),
    );
    expect(taken.reduce((s, t) => s + t, 0)).toBe(3000);
    expect(await walletBalance(id)).toBe(0);
  });
});
