import { describe, expect, it, vi } from "vitest";

// Cashfree has to be configured for checkout to reach the gateway path at all.
// Everywhere else the suite runs simulated, which is why this path went
// untested: set before the app, and so the env module, is imported.
vi.hoisted(() => {
  process.env.CASHFREE_APP_ID = "test-app-id";
});

import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { creditCashback, walletBalance } from "../src/modules/users/wallet.service.js";

// The amount a customer is charged has to be the amount they were shown.
//
// Cashfree order ids are unique per merchant, so a retried checkout that asks
// to create the same order again gets a 409, and the route reuses the session
// that already exists. That session carries the amount it was created with. A
// customer who began paying without their rewards and came back to apply them
// had the credit debited and was told the smaller amount, while the reused
// session still charged the full one: ₹485 plus ₹300 of credit for a ₹485
// order. The gateway only refuses to confirm an underpayment, so an
// overpayment confirmed without complaint.

/** A faithful enough Cashfree: unique order ids, 409 on reuse, fetch by id. */
function fakeCashfree() {
  const orders = new Map<string, { order_amount: number; payment_session_id: string }>();
  const real = globalThis.fetch;
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("cashfree.com/pg/orders")) return real(input, init);
    if ((init?.method ?? "GET") === "POST" && url.endsWith("/orders")) {
      const body = JSON.parse(String(init?.body));
      if (orders.has(body.order_id)) {
        return new Response(JSON.stringify({ message: "order already exists" }), { status: 409 });
      }
      const created = {
        order_amount: Number(body.order_amount),
        payment_session_id: `session_${body.order_id}_${body.order_amount}`,
      };
      orders.set(body.order_id, created);
      return new Response(
        JSON.stringify({ cf_order_id: `cf_${body.order_id}`, order_status: "ACTIVE", ...created }),
        { status: 200 },
      );
    }
    const id = url.split("/orders/")[1]!.split("/")[0]!;
    const found = orders.get(id);
    if (!found) return new Response("{}", { status: 404 });
    return new Response(
      JSON.stringify({ cf_order_id: `cf_${id}`, order_status: "ACTIVE", ...found }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fake);
  return { orders, restore: () => vi.unstubAllGlobals() };
}

async function placeOrder(agent: Awaited<ReturnType<typeof authedAgent>>["agent"]) {
  const res = await agent
    .post("/api/orders")
    .send({ domain: "food", items: [{ dishId: "dum-biryani", platform: "ondc", qty: 1 }] })
    .expect(201);
  return res.body.order as { id: string; amount: number };
}

describe("the gateway session charges what the customer was shown", () => {
  it("does not take reward credit once a full-price session exists", async () => {
    const gateway = fakeCashfree();
    try {
      const { agent, email } = await authedAgent();
      const me = await prisma.user.findUniqueOrThrow({ where: { email } });
      await creditCashback({ userId: me.id, orderId: "earn-cf", marginPaise: 10_000 }); // 3000

      const order = await placeOrder(agent);

      // First attempt, without the credit: the gateway is asked for the lot.
      await agent.post("/api/payments/checkout").send({ orderId: order.id }).expect(200);
      expect(gateway.orders.get(order.id)?.order_amount).toBe(order.amount / 100);

      // The customer returns and asks for the credit. The session that exists
      // still charges the full amount, so the credit must not be taken and the
      // customer must not be told a smaller number.
      const retry = await agent
        .post("/api/payments/checkout")
        .send({ orderId: order.id, useWallet: true });

      if (retry.status === 200) {
        expect(retry.body.amount).toBe(order.amount);
        expect(retry.body.walletAppliedPaise ?? 0).toBe(0);
      } else {
        expect(retry.status).toBe(409);
      }
      expect(await walletBalance(me.id)).toBe(3000);
    } finally {
      gateway.restore();
    }
  });

  it("never hands out a session whose amount differs from what is owed", async () => {
    const gateway = fakeCashfree();
    try {
      const { agent } = await authedAgent();
      const order = await placeOrder(agent);

      // A session already exists at the gateway for a different amount, the
      // shape of any path that changes the bill after payment started.
      gateway.orders.set(order.id, {
        order_amount: order.amount / 100 + 50,
        payment_session_id: "stale-session",
      });

      const res = await agent.post("/api/payments/checkout").send({ orderId: order.id });
      expect(res.body.paymentSessionId).not.toBe("stale-session");
      expect(res.status).toBe(409);
    } finally {
      gateway.restore();
    }
  });

  it("still applies reward credit when it is asked for up front", async () => {
    const gateway = fakeCashfree();
    try {
      const { agent, email } = await authedAgent();
      const me = await prisma.user.findUniqueOrThrow({ where: { email } });
      await creditCashback({ userId: me.id, orderId: "earn-cf-up", marginPaise: 10_000 }); // 3000
      const order = await placeOrder(agent);

      const res = await agent
        .post("/api/payments/checkout")
        .send({ orderId: order.id, useWallet: true })
        .expect(200);

      expect(res.body.walletAppliedPaise).toBe(3000);
      expect(res.body.amount).toBe(order.amount - 3000);
      // And the gateway was asked for exactly that.
      expect(gateway.orders.get(order.id)?.order_amount).toBe((order.amount - 3000) / 100);
    } finally {
      gateway.restore();
    }
  });

  it("reuses a matching session on a plain retry", async () => {
    // The 409 reuse exists for a reason: a customer who closes the gateway and
    // taps pay again must get the same session back, not an error.
    const gateway = fakeCashfree();
    try {
      const { agent } = await authedAgent();
      const order = await placeOrder(agent);
      const first = await agent.post("/api/payments/checkout").send({ orderId: order.id }).expect(200);
      const second = await agent.post("/api/payments/checkout").send({ orderId: order.id }).expect(200);
      expect(second.body.paymentSessionId).toBe(first.body.paymentSessionId);
      expect(second.body.amount).toBe(order.amount);
    } finally {
      gateway.restore();
    }
  });
});
