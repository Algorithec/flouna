import { afterEach, describe, expect, it, vi } from "vitest";

// The payment gateway is configured, so approving a refund moves real money.
vi.hoisted(() => {
  process.env.CASHFREE_APP_ID = "test-app";
  process.env.CASHFREE_SECRET_KEY = "test-secret";
});

import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { approveRefund, rejectRefund } from "../src/modules/backoffice/super.service.js";

// Approve and reject pressed at once on the same refund.
//
// Approving asks Cashfree to refund first and records it afterwards, so the
// books never claim money moved when it did not. But the record waited on a
// payment still awaiting review, and a reject pressed while Cashfree was
// answering found it awaiting review and won: the customer had their money
// back and the books said the charge was kept. The approval now claims the
// payment before calling Cashfree, so a reject in that window is refused.

afterEach(() => vi.unstubAllGlobals());

async function pendingRefund() {
  const { email } = await authedAgent();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      domain: "food",
      status: "cancelled",
      provider: "ondc",
      fulfillment: "in_app",
      title: "Refund race",
      details: "{}",
      amount: 30000,
    },
  });
  return prisma.payment.create({
    data: { orderId: order.id, userId: user.id, amount: 30000, status: "refund_pending" },
  });
}

/** Cashfree, answering after a pause like a real gateway, and counting refunds. */
function slowCashfree(ok = true) {
  const refunds: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).includes("cashfree.com")) throw new Error(`unexpected ${url}`);
      refunds.push(String(init?.body));
      await new Promise((r) => setTimeout(r, 250));
      return ok
        ? new Response(JSON.stringify({ cf_refund_id: "cf1", refund_status: "SUCCESS", refund_amount: 300 }), { status: 200 })
        : new Response(JSON.stringify({ message: "refund declined" }), { status: 400 });
    }),
  );
  return refunds;
}

describe("approving and rejecting the same refund at once", () => {
  it("never records a kept charge for money the gateway refunded", async () => {
    const payment = await pendingRefund();
    const refunds = slowCashfree();

    const approving = approveRefund(payment.id);
    await new Promise((r) => setTimeout(r, 50)); // reject lands while Cashfree answers
    const rejected = await rejectRefund(payment.id);
    const approved = await approving;

    expect(refunds).toHaveLength(1);
    expect(approved.ok).toBe(true);
    expect(rejected).toEqual({ ok: false, reason: "not_pending" });
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("refunded");
  });

  it("puts the refund back in the queue when the gateway declines", async () => {
    const payment = await pendingRefund();
    slowCashfree(false);
    const result = await approveRefund(payment.id);
    expect(result.ok).toBe(false);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("refund_pending");
  });

  it("refunds once when approved twice at once", async () => {
    const payment = await pendingRefund();
    const refunds = slowCashfree();
    const [a, b] = await Promise.all([approveRefund(payment.id), approveRefund(payment.id)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(refunds).toHaveLength(1);
  });
});
