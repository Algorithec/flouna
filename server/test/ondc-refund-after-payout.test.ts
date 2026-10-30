import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { markPayoutPaid, owe, recordPayout } from "../src/modules/ondc/ondcMoney.js";
import { recordSettlement } from "../src/modules/ondc/settlement.service.js";
import { authedAgent } from "./helpers.js";

// A refund after an order completed comes out of what the seller is owed.
// The customer is refunded at once; the seller's payout and settlement must
// then be held for an operator to reduce, or flagged for recovery if they
// were already paid. Before this, both stayed at the full amount, and paying
// them as recorded paid the refund twice.

const COMPLETED = new Date("2026-10-20T10:00:00Z");
let userId: string | undefined;

async function user() {
  if (!userId) {
    const a = await authedAgent();
    userId = (await prisma.user.findUniqueOrThrow({ where: { email: a.email } })).id;
  }
  return userId;
}

/** A completed order for 475 rupees, with its payout and settlement recorded. Flouna collected unless told otherwise. */
async function completedOrder(collectedBy: "BAP" | "BPP" = "BAP") {
  const id = crypto.randomUUID();
  const order = await prisma.ondcOrder.create({
    data: {
      userId: await user(),
      txnId: crypto.randomUUID(),
      status: "placed",
      bppId: "seller.refund.example",
      bppUri: "https://seller.refund.example/ondc",
      providerId: "p",
      locationId: "l",
      storeName: "Refund Store",
      city: "std:080",
      lines: "[]",
      sellerOrderId: `net-${id.slice(0, 8)}`,
      sellerState: "Completed",
      totalPaise: 47500,
      payment: JSON.stringify({ collectedBy, finderFee: "3", finderFeeType: "percent", settlementDetails: [{ settlement_counterparty: "seller-app" }] }),
      paidAt: new Date("2026-10-20T09:00:00Z"),
      paidPaise: 47500,
      paymentRef: "cf_pay_1",
    },
  });
  await recordPayout(order.id, COMPLETED);
  await recordSettlement(order.id, COMPLETED);
  return order.id;
}

const payoutOf = (id: string) => prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: id } });
const settlementOf = (id: string) => prisma.ondcSettlement.findUniqueOrThrow({ where: { ondcOrderId: id } });

afterEach(() => vi.restoreAllMocks());

describe("a refund after the order completed", () => {
  it("holds the seller's unpaid payout and settlement, saying how much to take off", async () => {
    const id = await completedOrder();
    expect((await payoutOf(id)).status).toBe("due");
    const errors = vi.spyOn(console, "error");

    await owe(id, { paise: 10000 });

    // Noted on the first try, so nothing is reported as missed.
    expect(errors.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("could not note"))).toEqual([]);

    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id } });
    expect(order.refundStatus).toBe("done");
    const payout = await payoutOf(id);
    expect(payout.status).toBe("held");
    expect(payout.note).toContain("Customer refunded Rs 100.00 after the order completed");
    // The amount itself is left for the operator: no guess is written in.
    expect(payout.amountPaise).toBe(47500 - 1425);
    const settlement = await settlementOf(id);
    expect(settlement.status).toBe("held");
    expect(settlement.note).toContain("Customer refunded Rs 100.00 after the order completed");
    // The note it was already held with is kept.
    expect(settlement.note).toContain("Cashfree confirms the arrangement");
  });

  it("holds a settlement that had already been released for payment", async () => {
    const id = await completedOrder();
    const row = await settlementOf(id);
    await prisma.ondcSettlement.update({ where: { id: row.id }, data: { status: "due", note: null } });

    await owe(id, { paise: 2000 });

    const settlement = await settlementOf(id);
    expect(settlement.status).toBe("held");
    expect(settlement.note).toBe("Customer refunded Rs 20.00 after the order completed: take it off before paying the seller.");
  });

  it("leaves the settlement alone where the seller collected, since the seller refunds its own customer", async () => {
    const id = await completedOrder("BPP");
    const before = await settlementOf(id);
    expect(before.role).toBe("receiver");

    await owe(id, { paise: 2000 });

    const after = await settlementOf(id);
    expect({ status: after.status, note: after.note }).toEqual({ status: before.status, note: before.note });
  });

  it("flags a payout already paid by hand for recovery, without unpaying it", async () => {
    const id = await completedOrder();
    const before = await payoutOf(id);
    expect(await markPayoutPaid(before.id, "op", "UTR123")).toBeTruthy();

    await owe(id, { paise: 47500 });

    const payout = await payoutOf(id);
    expect(payout.status).toBe("paid");
    expect(payout.note).toContain("RECOVER: customer refunded Rs 475.00 after the seller was paid");
  });

  it("flags a settlement the agency already settled for recovery", async () => {
    const id = await completedOrder();
    const row = await settlementOf(id);
    await prisma.ondcSettlement.update({ where: { id: row.id }, data: { status: "settled", settledPaise: row.interParticipantPaise, note: null } });

    await owe(id, { paise: 5000 });

    const settlement = await settlementOf(id);
    expect(settlement.status).toBe("settled");
    expect(settlement.note).toBe("RECOVER: customer refunded Rs 50.00 after the seller was paid. Recover it from the seller.");
  });

  it("notes each refund when there is more than one", async () => {
    const id = await completedOrder();
    await owe(id, { paise: 10000 });
    await owe(id, { paise: 25000 });

    const payout = await payoutOf(id);
    expect(payout.status).toBe("held");
    // The second refund sends only what was not refunded yet: 150 rupees.
    expect(payout.note).toContain("Rs 100.00");
    expect(payout.note).toContain("Rs 150.00");
  });

  it("says so loudly when the rows keep changing and no note can be written", async () => {
    const id = await completedOrder();
    vi.spyOn(prisma.ondcPayout, "updateMany").mockResolvedValue({ count: 0 });
    vi.spyOn(prisma.ondcSettlement, "updateMany").mockResolvedValue({ count: 0 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await owe(id, { paise: 3000 });

    const said = errors.mock.calls.map((c) => c.join(" "));
    expect(said).toContain(`[ondc] could not note a Rs 30.00 refund on the seller payout for order ${id}: check it before paying`);
    expect(said).toContain(`[ondc] could not note a Rs 30.00 refund on the settlement for order ${id}: check it before settling`);
  });
});
