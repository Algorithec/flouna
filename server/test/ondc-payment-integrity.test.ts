import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { gatewayOrderId, recordPayout } from "../src/modules/ondc/ondcMoney.js";
import { settleOndcPayment } from "../src/modules/ondc/ondcPay.service.js";
import { recordSettlement } from "../src/modules/ondc/settlement.service.js";
import { authedAgent } from "./helpers.js";

// Two ways money went wrong on ONDC orders Flouna collects for:
//   - a payment that arrived as the order changed was kept with no order,
//     and one that hit a database error was answered OK and never recorded;
//   - a seller's later bill above what the customer paid set the seller's
//     payout, so Flouna would have paid out more than it took.

let userId: string | undefined;
async function user() {
  if (!userId) {
    const a = await authedAgent();
    userId = (await prisma.user.findUniqueOrThrow({ where: { email: a.email } })).id;
  }
  return userId;
}

async function order(o: { status: string; totalPaise: number; paidPaise?: number; sellerState?: string }) {
  const id = crypto.randomUUID();
  return prisma.ondcOrder.create({
    data: {
      userId: await user(),
      txnId: crypto.randomUUID(),
      status: o.status,
      bppId: "seller.integrity.example",
      bppUri: "https://seller.integrity.example/ondc",
      providerId: "p",
      locationId: "l",
      storeName: "Integrity Store",
      city: "std:080",
      lines: "[]",
      sellerOrderId: o.sellerState ? `net-${id.slice(0, 8)}` : null,
      sellerState: o.sellerState ?? null,
      totalPaise: o.totalPaise,
      payment: JSON.stringify({ collectedBy: "BAP", finderFee: "3", finderFeeType: "percent", settlementDetails: [{ settlement_counterparty: "seller-app" }] }),
      ...(o.paidPaise != null ? { paidAt: new Date("2026-10-20T09:00:00Z"), paidPaise: o.paidPaise, paymentRef: "cf_pay_1" } : {}),
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("a payment arriving for an ONDC order", () => {
  it("fails, so the gateway sends it again, when the payment cannot be recorded", async () => {
    const o = await order({ status: "ready_to_pay", totalPaise: 47500 });
    vi.spyOn(prisma.ondcOrder, "updateMany").mockRejectedValueOnce(new Error("database unavailable"));

    await expect(settleOndcPayment(gatewayOrderId(o.id), 47500, "cf_pay_9")).rejects.toThrow("database unavailable");

    const after = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.paidAt).toBeNull();
    expect(after.status).toBe("ready_to_pay");
  });

  it("refunds a payment for an order that was cancelled while it was being paid", async () => {
    const o = await order({ status: "ready_to_pay", totalPaise: 47500 });
    // The order is cancelled between the payment check reading it and
    // marking it paid.
    const real = prisma.ondcOrder.updateMany.bind(prisma.ondcOrder);
    vi.spyOn(prisma.ondcOrder, "updateMany").mockImplementationOnce(async (args) => {
      await prisma.ondcOrder.update({ where: { id: o.id }, data: { status: "cancelled" } });
      return real(args as Parameters<typeof real>[0]);
    });

    expect(await settleOndcPayment(gatewayOrderId(o.id), 47500, "cf_pay_9")).toMatchObject({ outcome: "refunded" });

    const after = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.paidPaise).toBe(47500);
    expect(after.paymentRef).toBe("cf_pay_9");
    expect(after.refundDuePaise).toBe(47500);
    expect(after.problem).toBe("The order changed before the payment arrived, so it was refunded");
  });

  it("still answers a second delivery of the same payment as already paid", async () => {
    const o = await order({ status: "paid", totalPaise: 47500, paidPaise: 47500 });
    expect(await settleOndcPayment(gatewayOrderId(o.id), 47500, "cf_pay_1")).toMatchObject({ outcome: "already_paid" });
    expect((await prisma.ondcOrder.findUniqueOrThrow({ where: { id: o.id } })).refundDuePaise).toBeNull();
  });
});

describe("paying the seller for a completed order", () => {
  const COMPLETED = new Date("2026-10-20T10:00:00Z");

  it("works out the payout and settlement on what was paid when the seller billed more, and holds both", async () => {
    // The customer paid 475 rupees; a later status from the seller says 520.
    const o = await order({ status: "placed", totalPaise: 52000, paidPaise: 47500, sellerState: "Completed" });
    await recordPayout(o.id, COMPLETED);
    await recordSettlement(o.id, COMPLETED);

    const payout = await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: o.id } });
    expect(payout).toMatchObject({ status: "held", orderTotalPaise: 47500, feePaise: 1425, amountPaise: 46075 });
    expect(payout.note).toContain("The seller billed Rs 520.00 but the customer paid Rs 475.00");

    const settlement = await prisma.ondcSettlement.findUniqueOrThrow({ where: { ondcOrderId: o.id } });
    expect(settlement).toMatchObject({ status: "held", orderTotalPaise: 47500, feePaise: 1425, interParticipantPaise: 46075 });
    expect(settlement.note).toContain("The seller billed Rs 520.00 but the customer paid Rs 475.00");
  });

  it("leaves a payout on the seller's bill when it is what the customer paid", async () => {
    const o = await order({ status: "placed", totalPaise: 47500, paidPaise: 47500, sellerState: "Completed" });
    await recordPayout(o.id, COMPLETED);
    const payout = await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: o.id } });
    expect(payout).toMatchObject({ status: "due", note: null, orderTotalPaise: 47500, amountPaise: 46075 });
  });
});
