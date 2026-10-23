import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { markPayoutPaid, recordPayout } from "../src/modules/ondc/ondcMoney.js";
import { buildOnRecon, buildSettle, compareFigures } from "../src/modules/ondc/settlement.js";
import {
  applySettlementMessage,
  declareNilSettlement,
  instructSettlements,
  recordSettlement,
  releaseSettlement,
  sendRecon,
  type SettlementDeps,
} from "../src/modules/ondc/settlement.service.js";
import { authedAgent, consoleAgent } from "./helpers.js";
import { identity, reply } from "./ondc-order-helpers.js";

// ONDC settlement (RSF 2.0.0). The amounts are checked against what each side
// is owed, and every path that moves money against paying anyone twice.

const AGENCY = { id: "sa_nocs.nbbl.example", uri: "https://sa_nocs.nbbl.example/nocs_test" };
const SELLER = "seller.settle.example";
const SELLER_URI = "https://seller.settle.example/ondc";
const COMPLETED = new Date("2026-10-20T10:00:00Z");

beforeEach(() => {
  process.env.ONDC_SETTLEMENT_AGENCY_ID = AGENCY.id;
  process.env.ONDC_SETTLEMENT_AGENCY_URL = AGENCY.uri;
});
afterEach(() => {
  delete process.env.ONDC_SETTLEMENT_AGENCY_ID;
  delete process.env.ONDC_SETTLEMENT_AGENCY_URL;
  vi.restoreAllMocks();
});

let userId: string | null = null;
async function user() {
  if (!userId) {
    const a = await authedAgent();
    userId = (await prisma.user.findUniqueOrThrow({ where: { email: a.email } })).id;
  }
  return userId;
}

/** A completed ONDC order on the seller's terms, as on_init would have stored them. */
async function completedOrder(o: { collectedBy: "BAP" | "BPP"; totalPaise?: number; terms?: Record<string, unknown>; bppId?: string }) {
  const id = crypto.randomUUID();
  const order = await prisma.ondcOrder.create({
    data: {
      userId: await user(),
      txnId: crypto.randomUUID(),
      status: "placed",
      bppId: o.bppId ?? SELLER,
      bppUri: SELLER_URI,
      providerId: "p",
      locationId: "l",
      storeName: "Settle Store",
      city: "std:080",
      lines: "[]",
      sellerOrderId: `net-${id.slice(0, 8)}`,
      sellerState: "Completed",
      totalPaise: o.totalPaise ?? 47500,
      payment: JSON.stringify({ collectedBy: o.collectedBy, finderFee: "3", finderFeeType: "percent", settlementDetails: [{ settlement_counterparty: "seller-app" }], ...o.terms }),
      ...(o.collectedBy === "BAP" ? { paidAt: new Date("2026-10-20T09:00:00Z"), paidPaise: o.totalPaise ?? 47500, paymentRef: "cf_pay_1" } : {}),
    },
  });
  await recordPayout(order.id, COMPLETED);
  await recordSettlement(order.id, COMPLETED);
  return { order, settlement: await prisma.ondcSettlement.findUniqueOrThrow({ where: { ondcOrderId: order.id } }) };
}

function capture(ack = true): SettlementDeps & { sent: { url: string; action: string; envelope: any }[] } {
  const sent: { url: string; action: string; envelope: any }[] = [];
  return {
    sent,
    identity,
    now: () => new Date("2026-11-01T00:00:00Z"),
    send: async (url, action, envelope) => {
      sent.push({ url, action, envelope });
      return ack ? { ack: true, status: 200 } : { ack: false, status: 500 };
    },
  };
}

describe("what each side is owed for an order", () => {
  it("when the seller collected, the seller owes us the finder fee and nothing else moves", async () => {
    const { settlement } = await completedOrder({ collectedBy: "BPP", terms: { settlementBasis: "delivery", settlementWindow: "P7D" } });
    expect(settlement).toMatchObject({
      role: "receiver",
      orderTotalPaise: 47500,
      feePaise: 1425,
      interParticipantPaise: 1425,
      collectorPaise: 46075,
      selfPaise: 1425,
      status: "due",
      dueAt: new Date("2026-10-27T10:00:00Z"),
    });
    // And no seller payout: Flouna took none of the money.
    expect(await prisma.ondcPayout.count({ where: { ondcOrderId: settlement.ondcOrderId } })).toBe(0);
  });

  it("when Flouna collected, we owe the seller the total less our fee, and it waits for a person", async () => {
    const { settlement } = await completedOrder({ collectedBy: "BAP" });
    expect(settlement).toMatchObject({ role: "collector", feePaise: 1425, interParticipantPaise: 46075, collectorPaise: 1425, selfPaise: 1425, status: "held" });
    expect(settlement.note).toMatch(/Cashfree/);
  });

  it("reads a fixed finder fee as an amount, and never lets it exceed the order", async () => {
    const fixed = await completedOrder({ collectedBy: "BPP", terms: { finderFee: "20.00", finderFeeType: "amount" } });
    expect(fixed.settlement.feePaise).toBe(2000);
    const huge = await completedOrder({ collectedBy: "BPP", totalPaise: 1000, terms: { finderFee: "50.00", finderFeeType: "amount" } });
    expect(huge.settlement.feePaise).toBe(1000);
  });

  it("holds an order whose seller withholds money or settles after its return window", async () => {
    const withheld = await completedOrder({ collectedBy: "BPP", terms: { withholdingPaise: 1000 } });
    expect(withheld.settlement).toMatchObject({ status: "held", withholdingPaise: 1000 });
    const returns = await completedOrder({ collectedBy: "BPP", terms: { settlementBasis: "return_window_expiry" } });
    expect(returns.settlement.status).toBe("held");
  });

  it("records an order once, however often the seller says it is completed", async () => {
    const { order } = await completedOrder({ collectedBy: "BPP" });
    await recordSettlement(order.id, new Date());
    expect(await prisma.ondcSettlement.count({ where: { ondcOrderId: order.id } })).toBe(1);
  });
});

describe("instructing the settlement agency", () => {
  it("sends one instruction to the agency, in the form ONDC's NP-NP example uses", async () => {
    const bppId = `rcv-${crypto.randomUUID().slice(0, 6)}.example`;
    const { settlement } = await completedOrder({ collectedBy: "BPP", bppId });
    const deps = capture();
    const result = await instructSettlements({ bppId, role: "receiver" }, deps);
    expect(result).toMatchObject({ orders: 1, skipped: [] });
    // The agency's base address: the action is added by the sender, once.
    expect(deps.sent).toEqual([expect.objectContaining({ url: AGENCY.uri, action: "settle" })]);
    const { context, message } = deps.sent[0]!.envelope;
    expect(context).toMatchObject({ domain: "ONDC:NTS10", version: "2.0.0", action: "settle", bap_id: "ondc.flouna.com", bpp_id: AGENCY.id, location: { country: { code: "IND" }, city: { code: "*" } }, ttl: "P1D" });
    expect(message).toEqual({
      collector_app_id: bppId,
      receiver_app_id: "ondc.flouna.com",
      settlement: {
        type: "NP-NP",
        id: result.settlementId,
        orders: [
          {
            id: settlement.networkOrderId,
            inter_participant: { amount: { currency: "INR", value: "14.25" } },
            collector: { amount: { currency: "INR", value: "460.75" } },
            self: { amount: { currency: "INR", value: "14.25" } },
          },
        ],
      },
    });
    const after = await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(after).toMatchObject({ status: "instructed", settlementId: result.settlementId, settleTxnId: context.transaction_id, settleMsgId: context.message_id });
    // Pressing it again finds nothing due.
    await expect(instructSettlements({ bppId, role: "receiver" }, capture())).rejects.toThrow(/Nothing is due/);
  });

  it("lets go of everything it claimed when the agency does not acknowledge", async () => {
    const bppId = `nack-${crypto.randomUUID().slice(0, 6)}.example`;
    const { settlement } = await completedOrder({ collectedBy: "BAP", bppId });
    await releaseSettlement(settlement.id);
    await expect(instructSettlements({ bppId, role: "collector" }, capture(false))).rejects.toThrow(/did not accept/);
    expect(await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({ status: "due", settlementId: null });
    expect((await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: settlement.ondcOrderId } })).status).toBe("due");
  });

  it("claims nothing when the instruction cannot be signed", async () => {
    const bppId = `noid-${crypto.randomUUID().slice(0, 6)}.example`;
    const { settlement } = await completedOrder({ collectedBy: "BAP", bppId });
    await releaseSettlement(settlement.id);
    await expect(instructSettlements({ bppId, role: "collector" }, { ...capture(), identity: () => null })).rejects.toThrow(/not configured/);
    expect((await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe("due");
    expect((await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: settlement.ondcOrderId } })).status).toBe("due");
  });

  it("puts a held payout back as it was, note and all, when the agency refuses", async () => {
    const bppId = `held-${crypto.randomUUID().slice(0, 6)}.example`;
    const { settlement } = await completedOrder({ collectedBy: "BAP", bppId });
    await prisma.ondcPayout.update({ where: { ondcOrderId: settlement.ondcOrderId }, data: { status: "held", note: "Waiting on the return window" } });
    await releaseSettlement(settlement.id);
    await expect(instructSettlements({ bppId, role: "collector" }, capture(false))).rejects.toThrow(/did not accept/);
    expect(await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: settlement.ondcOrderId } })).toMatchObject({ status: "held", note: "Waiting on the return window" });
  });

  it("keeps an instruction the agency accepted even if it cannot be logged", async () => {
    const bppId = `log-${crypto.randomUUID().slice(0, 6)}.example`;
    const { settlement } = await completedOrder({ collectedBy: "BPP", bppId });
    vi.spyOn(prisma.ondcTransaction, "create").mockRejectedValueOnce(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await instructSettlements({ bppId, role: "receiver" }, capture());
    expect(await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({ status: "instructed", settlementId: result.settlementId });
  });

  it("never pays a seller twice: settling claims the payout, and a payout paid by hand keeps the order out", async () => {
    const bppId = `twice-${crypto.randomUUID().slice(0, 6)}.example`;
    const a = await completedOrder({ collectedBy: "BAP", bppId });
    const b = await completedOrder({ collectedBy: "BAP", bppId });
    await releaseSettlement(a.settlement.id);
    await releaseSettlement(b.settlement.id);
    // b's seller was already paid by hand.
    const bPayout = await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: b.order.id } });
    expect(await markPayoutPaid(bPayout.id, "op", "UTR000111")).toBe(true);

    const deps = capture();
    const result = await instructSettlements({ bppId, role: "collector" }, deps);
    expect(result.orders).toBe(1);
    expect(result.skipped).toEqual([{ id: b.settlement.id, reason: "payout not waiting" }]);
    expect(deps.sent[0]!.envelope.message.settlement.orders.map((x: { id: string }) => x.id)).toEqual([a.settlement.networkOrderId]);
    // a's payout can no longer be paid by hand; b waits for a person.
    const aPayout = await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: a.order.id } });
    expect(aPayout.status).toBe("via_rsf");
    expect(await markPayoutPaid(aPayout.id, "op", "UTR000222")).toBe(false);
    expect((await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: b.settlement.id } })).status).toBe("held");
  });

  it("instructs every order once when several people send at the same moment", async () => {
    const bppId = `race-${crypto.randomUUID().slice(0, 6)}.example`;
    for (let i = 0; i < 12; i++) await completedOrder({ collectedBy: "BPP", bppId });
    const senders = [capture(), capture(), capture()];
    const results = await Promise.allSettled(senders.map((d) => instructSettlements({ bppId, role: "receiver" }, d)));
    // Across all the instructions sent, each order appears exactly once.
    const sentIds = senders.flatMap((d) => d.sent).flatMap((s) => s.envelope.message.settlement.orders.map((o: { id: string }) => o.id));
    expect(sentIds).toHaveLength(12);
    expect(new Set(sentIds).size).toBe(12);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("sends nothing for orders another instruction claimed between being read and being claimed", async () => {
    const bppId = `stale-${crypto.randomUUID().slice(0, 6)}.example`;
    await completedOrder({ collectedBy: "BPP", bppId });
    await completedOrder({ collectedBy: "BPP", bppId });
    const read = prisma.ondcSettlement.findMany.bind(prisma.ondcSettlement);
    vi.spyOn(prisma.ondcSettlement, "findMany").mockImplementationOnce((async (args: Parameters<typeof read>[0]) => {
      const rows = await read(args);
      // Someone else's instruction claims them right after we read them.
      await prisma.ondcSettlement.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "instructed", settlementId: "someone-else" } });
      return rows;
    }) as never);
    const deps = capture();
    await expect(instructSettlements({ bppId, role: "receiver" }, deps)).rejects.toThrow(/Nothing was left/);
    expect(deps.sent).toHaveLength(0);
    expect(await prisma.ondcSettlement.count({ where: { bppId, settlementId: "someone-else" } })).toBe(2);
  });

  it("refuses without a settlement agency, and refuses a nil cycle while sellers are owed", async () => {
    delete process.env.ONDC_SETTLEMENT_AGENCY_ID;
    delete process.env.ONDC_SETTLEMENT_AGENCY_URL;
    await expect(instructSettlements({ bppId: SELLER, role: "receiver" }, capture())).rejects.toThrow(/No settlement agency/);
    process.env.ONDC_SETTLEMENT_AGENCY_ID = AGENCY.id;
    process.env.ONDC_SETTLEMENT_AGENCY_URL = AGENCY.uri;
    await completedOrder({ collectedBy: "BAP" });
    await expect(declareNilSettlement(capture())).rejects.toThrow(/not nil/);
  });
});

describe("the agency's answers", () => {
  async function instructed(collectedBy: "BAP" | "BPP") {
    const bppId = `ans-${crypto.randomUUID().slice(0, 6)}.example`;
    const { order, settlement } = await completedOrder({ collectedBy, bppId });
    if (collectedBy === "BAP") await releaseSettlement(settlement.id);
    const deps = capture();
    const result = await instructSettlements({ bppId, role: collectedBy === "BAP" ? "collector" : "receiver" }, deps);
    return { order, settlement, result, ctx: deps.sent[0]!.envelope.context };
  }
  const onSettle = (settlementId: string, networkOrderId: string, inter: Record<string, unknown>) => ({
    context: { domain: "ONDC:NTS10", version: "2.0.0", location: { country: { code: "IND" }, city: { code: "*" } }, bpp_uri: AGENCY.uri, ttl: "P1D" },
    message: {
      settlement: {
        type: "NP-NP",
        id: settlementId,
        orders: [{ id: networkOrderId, inter_participant: { amount: { currency: "INR", value: "14.25" }, ...inter }, self: { amount: { currency: "INR", value: "14.25" } } }],
      },
    },
  });

  it("marks an order settled from the agency's signed on_settle, and ignores the same message from anyone else", async () => {
    const { settlement, result, ctx } = await instructed("BPP");
    const body = onSettle(result.settlementId, settlement.networkOrderId, { settled_amount: { currency: "INR", value: "14.25" }, status: "SETTLED", reference_no: "NOCS-REF-1" });
    // Signed by a seller app, not the agency: changes nothing.
    await reply("on_settle", structuredClone(body), { txnId: ctx.transaction_id, messageId: ctx.message_id, from: "someone.else.example" }).expect(200);
    expect((await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).status).toBe("instructed");
    await reply("on_settle", structuredClone(body), { txnId: ctx.transaction_id, messageId: ctx.message_id, from: AGENCY.id }).expect(200);
    expect(await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({ status: "settled", settledPaise: 1425, referenceNo: "NOCS-REF-1" });
  });

  it("sends a seller's payout back to a person when the agency could not settle it", async () => {
    const { settlement, result, ctx } = await instructed("BAP");
    const body = onSettle(result.settlementId, settlement.networkOrderId, { settled_amount: { currency: "INR", value: "0.00" }, status: "NOT_SETTLED", reference_no: "", error: { code: "70025", message: "Insufficient balance in collector account" } });
    await reply("on_settle", body, { txnId: ctx.transaction_id, messageId: ctx.message_id, from: AGENCY.id }).expect(200);
    expect(await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({ status: "not_settled", errorCode: "70025" });
    const payout = await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: settlement.ondcOrderId } });
    expect(payout.status).toBe("held");
    expect(payout.note).toMatch(/check with the settlement agency/);
  });

  it("says so loudly if the agency settles after the seller was already paid by hand", async () => {
    const { settlement, result, ctx } = await instructed("BAP");
    await reply("on_settle", onSettle(result.settlementId, settlement.networkOrderId, { settled_amount: { currency: "INR", value: "0.00" }, status: "NOT_SETTLED", reference_no: "" }), { txnId: ctx.transaction_id, messageId: ctx.message_id, from: AGENCY.id }).expect(200);
    const payout = await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: settlement.ondcOrderId } });
    expect(await markPayoutPaid(payout.id, "op", "UTR999888")).toBe(true);
    // A later report says it did settle after all.
    await reply("on_report", onSettle(result.settlementId, settlement.networkOrderId, { settled_amount: { currency: "INR", value: "460.75" }, status: "SETTLED", reference_no: "NOCS-LATE" }), { txnId: crypto.randomUUID(), messageId: crypto.randomUUID(), from: AGENCY.id }).expect(200);
    const row = await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(row.status).toBe("settled");
    expect(row.note).toMatch(/PAID TWICE/);
    expect((await prisma.ondcPayout.findUniqueOrThrow({ where: { id: payout.id } })).note).toMatch(/PAID TWICE/);
  });
});

describe("reconciling with the seller app", () => {
  const reconBody = (orders: unknown[]) => ({
    context: { domain: "ONDC:NTS10", version: "2.0.0", location: { country: { code: "IND" }, city: { code: "*" } }, bpp_uri: SELLER_URI, ttl: "P1D" },
    message: { orders },
  });
  const theirOrder = (id: string, amount: string, tds = "0.00") => ({
    id,
    amount: { currency: "INR", value: "475.00" },
    settlements: [
      {
        id: "their-s-1",
        payment_id: "p",
        status: "PENDING",
        amount: { currency: "INR", value: amount },
        commission: { currency: "INR", value: "14.25" },
        withholding_amount: { currency: "INR", value: "0.00" },
        tcs: { currency: "INR", value: "0.00" },
        tds: { currency: "INR", value: tds },
        updated_at: "2026-10-21T10:00:00.000Z",
      },
    ],
  });

  it("answers a seller's recon at its own address, agreeing where the figures match and stating the difference where not", async () => {
    const bppId = SELLER;
    const agree = await completedOrder({ collectedBy: "BPP", bppId, terms: { settlementWindow: "P7D" } });
    const differ = await completedOrder({ collectedBy: "BPP", bppId });
    // The real sender, with the network stubbed: proves the URL it posts to.
    const posts: { url: string; body: any }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) });
      return new Response(JSON.stringify({ message: { ack: { status: "ACK" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    process.env.ONDC_SUBSCRIBER_ID ??= "ondc.flouna.com";
    const deps = { identity };
    await applySettlementMessage(
      {
        action: "recon",
        senderId: bppId,
        body: { ...reconBody([theirOrder(agree.settlement.networkOrderId, "14.25"), theirOrder(differ.settlement.networkOrderId, "12.83", "1.42")]), context: { ...reconBody([]).context, action: "recon", bap_id: "ondc.flouna.com", bpp_id: bppId, transaction_id: "t-recon-1", message_id: "m-recon-1" } },
      },
      deps,
    );
    expect(posts.map((p) => p.url)).toEqual([`${SELLER_URI}/on_recon`]);
    const answer = posts[0]!.body;
    expect(answer.context).toMatchObject({ action: "on_recon", transaction_id: "t-recon-1", message_id: "m-recon-1", bpp_id: bppId });
    const [first, second] = answer.message.orders;
    expect(first).toMatchObject({ id: agree.settlement.networkOrderId, recon_accord: true, settlements: [{ due_date: "2026-10-27", amount: { value: "14.25" } }] });
    expect(second.recon_accord).toBe(false);
    expect(second.settlements[0].amount).toEqual({ currency: "INR", value: "14.25", diff_value: "1.42" });
    expect(second.settlements[0].tds).toEqual({ currency: "INR", value: "0.00", diff_value: "1.42" });
    expect(second.settlements[0].due_date).toBeUndefined();
    expect((await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: differ.settlement.id } })).reconStatus).toBe("dispute");
    expect((await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: agree.settlement.id } })).reconStatus).toBe("accord");
  });

  it("answers a recon about an order it does not have with ONDC's invalid order error", async () => {
    const deps = capture();
    await completedOrder({ collectedBy: "BPP", bppId: SELLER });
    await applySettlementMessage(
      { action: "recon", senderId: SELLER, body: { ...reconBody([theirOrder("not-ours", "14.25")]), context: { ...reconBody([]).context, action: "recon", transaction_id: "t2", message_id: "m2" } } },
      deps,
    );
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.envelope.error).toEqual({ code: "70030", message: "Invalid Order Id: not-ours" });
  });

  it("sends our figures to the seller and records its on_recon", async () => {
    const bppId = `rec-${crypto.randomUUID().slice(0, 6)}.example`;
    const { settlement } = await completedOrder({ collectedBy: "BPP", bppId });
    const deps = capture();
    await sendRecon([settlement.id], deps);
    expect(deps.sent[0]).toMatchObject({ url: SELLER_URI, action: "recon" });
    expect(deps.sent[0]!.envelope.message.orders[0]).toMatchObject({ id: settlement.networkOrderId, settlements: [{ status: "TO_BE_INITIATED", commission: { value: "14.25" } }] });
    const txn = deps.sent[0]!.envelope.context.transaction_id;
    await reply("on_recon", { ...reconBody([{ ...theirOrder(settlement.networkOrderId, "14.25"), recon_accord: true }]), context: { ...reconBody([]).context } }, { txnId: txn, messageId: crypto.randomUUID(), from: bppId }).expect(200);
    expect(await prisma.ondcSettlement.findUniqueOrThrow({ where: { id: settlement.id } })).toMatchObject({ reconStatus: "accord" });
  });
});

describe("building the messages", () => {
  it("refuses an instruction that would put the wrong thing on the wire", () => {
    const base = { agency: AGENCY, collectorAppId: "c", receiverAppId: "r", settlementId: "s" };
    expect(() => buildSettle({ ...base, orders: [] })).toThrow(/at least one order/);
    expect(() => buildSettle({ ...base, orders: [{ networkOrderId: "o", interParticipantPaise: -1, collectorPaise: 0, selfPaise: 0 }] })).toThrow(/paise/);
    expect(() => buildSettle({ ...base, orders: [{ networkOrderId: "o", interParticipantPaise: 1.5, collectorPaise: 0, selfPaise: 0 }] })).toThrow(/paise/);
    const one = { networkOrderId: "o", interParticipantPaise: 1, collectorPaise: 0, selfPaise: 0 };
    expect(() => buildSettle({ ...base, orders: [one, one] })).toThrow(/twice/);
  });

  it("only agrees when every figure and the order total match, and invents no difference for a missing figure", () => {
    const ours = { networkOrderId: "o", orderTotalPaise: 47500, settlementId: "s", paymentId: "p", status: "PENDING" as const, amountPaise: 1425, commissionPaise: 1425, withholdingPaise: 0, tcsPaise: 0, tdsPaise: 0, updatedAt: new Date() };
    const theirs = { networkOrderId: "o", orderTotalPaise: 47500, amountPaise: 1425, commissionPaise: 1425, withholdingPaise: 0, tcsPaise: 0, tdsPaise: 0 };
    expect(compareFigures(ours, theirs)).toEqual({ agree: true, diffs: {}, unreadable: [] });
    expect(compareFigures(ours, { ...theirs, orderTotalPaise: 47000 }).agree).toBe(false);
    expect(compareFigures(ours, { ...theirs, tdsPaise: null })).toEqual({ agree: false, diffs: {}, unreadable: ["tds"] });
    const answer = buildOnRecon({ bpp: { id: "b", uri: "https://b.example" }, transactionId: "t", messageId: "m", answer: { orders: [{ ...ours, accord: false, diffs: {} }] } });
    expect(answer.message!.orders[0]!.settlements[0]!.amount).toEqual({ currency: "INR", value: "14.25" });
  });
});

describe("the settlement console", () => {
  it("is for admins only, and every money action needs one", async () => {
    const admin = await consoleAgent("admin");
    await admin.agent.get("/api/console/admin/ondc/settlements").expect(200);
    const { settlement } = await completedOrder({ collectedBy: "BAP" });
    await admin.agent.post(`/api/console/admin/ondc/settlements/${settlement.id}/release`).expect(200);
    await admin.agent.post(`/api/console/admin/ondc/settlements/${settlement.id}/release`).expect(409);
    const user = await authedAgent();
    await user.agent.get("/api/console/admin/ondc/settlements").expect(404);
    await user.agent.post("/api/console/admin/ondc/settlements/instruct").send({ bppId: SELLER, role: "receiver" }).expect(404);
  });
});
