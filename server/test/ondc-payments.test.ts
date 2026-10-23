import crypto from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { cancelOndcOrder, initOndcOrder, ondcOrderView } from "../src/modules/ondc/orders.service.js";
import { settleOndcPayment, startOndcPayment, verifyOndcPayment } from "../src/modules/ondc/ondcPay.service.js";
import { durationMs, markPayoutPaid, refundAfterCancel, refundsNeedingAttention, resolveRefund } from "../src/modules/ondc/ondcMoney.js";
import { app } from "./helpers.js";
import { customerWithSearch, fx, recorder, reply, SELLER, startPizza } from "./ondc-order-helpers.js";

// Paying for an ONDC order, refunding it, and owing the seller app its share.
// The gateway is a test double; the webhook's signature check is the real one.

const gateway = vi.hoisted(() => ({
  createCashfreeOrder: vi.fn(),
  getCashfreeOrder: vi.fn(),
  createCashfreeRefund: vi.fn(),
}));
vi.mock("../src/modules/payments/cashfree.js", async (original) => ({
  ...(await original<typeof import("../src/modules/payments/cashfree.js")>()),
  cashfreeConfigured: true,
  ...gateway,
}));

const SECRET = "test_webhook_secret";
let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = env.CASHFREE_SECRET_KEY;
  env.CASHFREE_SECRET_KEY = SECRET;
});
afterAll(() => {
  env.CASHFREE_SECRET_KEY = savedSecret;
});
beforeEach(() => {
  gateway.createCashfreeOrder.mockReset().mockResolvedValue({ cf_order_id: "cf_1", payment_session_id: "session_1", order_status: "ACTIVE" });
  gateway.getCashfreeOrder.mockReset();
  gateway.createCashfreeRefund.mockReset().mockResolvedValue({ cf_refund_id: "rf_1", refund_id: "x", refund_status: "SUCCESS", refund_amount: 0 });
});

/** An order the seller has given its final total for (₹475), waiting to be paid. */
async function readyToPay() {
  const c = await customerWithSearch();
  const r = recorder();
  const { orderId } = await startPizza(c, r.deps);
  const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: orderId } });
  await reply("on_select", fx("on_select"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
  await initOndcOrder(c.userId, orderId, r.deps);
  await reply("on_init", fx("on_init"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
  return { c, r, orderId, txnId: order.txnId, gid: `ondc_${orderId}` };
}

/** Paid through the gateway and accepted by the seller. */
async function paidAndPlaced(confirmed = fx("on_confirm")) {
  const o = await readyToPay();
  await settleOndcPayment(o.gid, 47500, "cf_pay_1", o.r.deps);
  await reply("on_confirm", confirmed, { txnId: o.txnId, messageId: o.r.last().envelope.context.message_id, at: new Date("2026-10-21T10:00:00Z") }).expect(200);
  return o;
}

function webhook(orderId: string, rupees: number) {
  const body = JSON.stringify({
    type: "PAYMENT_SUCCESS_WEBHOOK",
    data: { order: { order_id: orderId, order_amount: rupees }, payment: { payment_status: "SUCCESS", payment_amount: rupees, cf_payment_id: 991, payment_group: "upi" } },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", SECRET).update(ts + body).digest("base64");
  return request(app)
    .post("/api/payments/webhook/cashfree")
    .set("Content-Type", "application/json")
    .set("x-webhook-timestamp", ts)
    .set("x-webhook-signature", sig)
    .send(body);
}

describe("paying for an ONDC order", () => {
  it("asks the gateway for exactly the seller's final total, under an id the webhook can recognise", async () => {
    const o = await readyToPay();
    const started = await startOndcPayment(o.c.userId, o.orderId);
    expect(started).toMatchObject({ paymentSessionId: "session_1", amountPaise: 47500 });
    expect(gateway.createCashfreeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: o.gid, amountPaise: 47500, customerPhone: "9000000001", returnUrl: expect.stringContaining(`/food/ondc/${o.orderId}`) }),
    );
  });

  it("reuses the gateway's session on a second tap only if it charges the same total", async () => {
    const o = await readyToPay();
    gateway.createCashfreeOrder.mockRejectedValue(Object.assign(new Error("exists"), { cfStatus: 409 }));
    gateway.getCashfreeOrder.mockResolvedValue({ cf_order_id: "cf_1", order_status: "ACTIVE", order_amount: 475, payment_session_id: "session_1" });
    expect((await startOndcPayment(o.c.userId, o.orderId)).paymentSessionId).toBe("session_1");
    gateway.getCashfreeOrder.mockResolvedValue({ cf_order_id: "cf_1", order_status: "ACTIVE", order_amount: 470, payment_session_id: "session_1" });
    await expect(startOndcPayment(o.c.userId, o.orderId)).rejects.toThrow(/total changed/);
  });

  it("refuses payment for someone else's order, or one with no final total yet", async () => {
    const o = await readyToPay();
    const other = await customerWithSearch();
    await expect(startOndcPayment(other.userId, o.orderId)).rejects.toThrow(/not found/);
    const r = recorder();
    const { orderId } = await startPizza(other, r.deps);
    await expect(startOndcPayment(other.userId, orderId)).rejects.toThrow(/selecting, not waiting for payment/);
    expect(gateway.createCashfreeOrder).not.toHaveBeenCalled();
  });

  it("marks the order paid from the gateway's signed webhook, once however often it repeats", async () => {
    const o = await readyToPay();
    await webhook(o.gid, 475).expect(200);
    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order).toMatchObject({ paidPaise: 47500, paymentRef: "991" });
    // Placing it with the seller needs this deployment's ONDC identity, which
    // tests do not have: it stays paid, to be placed on retry.
    expect(order.status).toBe("paid");
    // And says so, which is what offers the customer "Place order again".
    expect(order.problem).toMatch(/could not be reached/);
    await webhook(o.gid, 475).expect(200);
    expect(gateway.createCashfreeRefund).not.toHaveBeenCalled();
    // A forged webhook changes nothing.
    await request(app).post("/api/payments/webhook/cashfree").set("x-webhook-timestamp", "1").set("x-webhook-signature", "x").send({}).expect(401);
  });

  it("places the paid order with the seller straight away", async () => {
    const o = await readyToPay();
    expect(await settleOndcPayment(o.gid, 47500, "cf_pay_1", o.r.deps)).toMatchObject({ outcome: "placed" });
    expect(o.r.last().action).toBe("confirm");
    expect(o.r.last().envelope.message.order.payment).toMatchObject({ status: "PAID", params: { amount: "475.00", transaction_id: "cf_pay_1" } });
    expect((await ondcOrderView(o.c.userId, o.orderId)).status).toBe("confirming");
    expect(await settleOndcPayment(o.gid, 47500, "cf_pay_1", o.r.deps)).toMatchObject({ outcome: "already_paid" });
  });

  it("refunds in full a payment that does not match the order, with one fixed refund id", async () => {
    const o = await readyToPay();
    expect(await settleOndcPayment(o.gid, 47000, "cf_pay_2", o.r.deps)).toMatchObject({ outcome: "refunded" });
    expect(o.r.sent.some((s) => s.action === "confirm")).toBe(false);
    expect(gateway.createCashfreeRefund).toHaveBeenCalledWith(expect.objectContaining({ orderId: o.gid, refundId: `${o.gid}_refund_0_47000`, amountRupees: 470 }));
    const view = await ondcOrderView(o.c.userId, o.orderId);
    expect(view).toMatchObject({ status: "failed", refund: { status: "done", paise: 47000 } });
  });

  it("asks the gateway, not the browser, when the customer comes back", async () => {
    const o = await readyToPay();
    gateway.getCashfreeOrder.mockResolvedValue({ cf_order_id: "cf_9", order_status: "ACTIVE", order_amount: 475, payment_session_id: "s" });
    expect(await verifyOndcPayment(o.c.userId, o.orderId, {}, o.r.deps)).toMatchObject({ status: "ready_to_pay", gateway: "ACTIVE" });
    gateway.getCashfreeOrder.mockResolvedValue({ cf_order_id: "cf_9", order_status: "PAID", order_amount: 475, payment_session_id: "s" });
    expect(await verifyOndcPayment(o.c.userId, o.orderId, {}, o.r.deps)).toMatchObject({ status: "confirming" });
  });
});

describe("refunding a paid ONDC order", () => {
  it("refunds in full when the seller will not accept the order", async () => {
    const rejected = fx("on_confirm");
    rejected.message.order.state = "Cancelled";
    const o = await paidAndPlaced(rejected);
    expect(gateway.createCashfreeRefund).toHaveBeenCalledWith(expect.objectContaining({ amountRupees: 475 }));
    expect((await ondcOrderView(o.c.userId, o.orderId)).refund).toEqual({ status: "done", paise: 47500 });
  });

  it("refunds what was paid less the seller's final bill when the customer cancels", async () => {
    const o = await paidAndPlaced();
    await cancelOndcOrder(o.c.userId, o.orderId, "006", o.r.deps);
    const cancelled = fx("on_status_pending");
    cancelled.message.order.state = "Cancelled";
    cancelled.message.order.cancellation = { cancelled_by: "ondc.flouna.com", reason: { id: "006" } };
    // The seller keeps delivery and convenience (₹80) and charges nothing for the food.
    const q = cancelled.message.order.quote;
    for (const line of q.breakup) if (line["@ondc/org/title_type"] === "item") line.price.value = "0.00";
    q.price.value = "80.00";
    await reply("on_cancel", cancelled, { txnId: o.txnId, messageId: o.r.last().envelope.context.message_id, at: new Date("2026-10-21T10:20:00Z") }).expect(200);
    expect(gateway.createCashfreeRefund).toHaveBeenCalledWith(expect.objectContaining({ amountRupees: 395 }));
    // The seller repeating itself refunds nothing more.
    await reply("on_status", cancelled, { txnId: o.txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-21T10:21:00Z") }).expect(200);
    expect(gateway.createCashfreeRefund).toHaveBeenCalledTimes(1);
  });

  it("refunds in full when the seller cancels, and holds for a person when the bill is missing", () => {
    expect(refundAfterCancel({ paidPaise: 47500, cancelledBySeller: true, finalTotalPaise: 8000 })).toEqual({ paise: 47500 });
    expect(refundAfterCancel({ paidPaise: 47500, cancelledBySeller: false })).toEqual({ review: expect.stringMatching(/without a final bill/) });
    expect(refundAfterCancel({ paidPaise: 47500, cancelledBySeller: false, finalTotalPaise: 50000 })).toEqual({ review: expect.stringMatching(/more than was paid/) });
  });

  it("puts a refund that never heard back from the gateway in front of a person", async () => {
    const o = await paidAndPlaced();
    // As if the server stopped after claiming the refund and before the gateway answered.
    await prisma.ondcOrder.update({ where: { id: o.orderId }, data: { refundStatus: "requested", refundPaise: 47500 } });
    const ids = async (at: Date) => (await refundsNeedingAttention(at)).map((r) => r.id);
    expect(await ids(new Date())).not.toContain(o.orderId);
    expect(await ids(new Date(Date.now() + 16 * 60_000))).toContain(o.orderId);
  });

  it("lets an operator settle a held refund only up to what was paid", async () => {
    const o = await paidAndPlaced();
    await cancelOndcOrder(o.c.userId, o.orderId, "006", o.r.deps);
    const noBill = fx("on_status_pending");
    noBill.message.order.state = "Cancelled";
    delete noBill.message.order.quote;
    await reply("on_cancel", noBill, { txnId: o.txnId, messageId: o.r.last().envelope.context.message_id, at: new Date("2026-10-21T10:20:00Z") }).expect(200);
    expect((await ondcOrderView(o.c.userId, o.orderId)).refund).toMatchObject({ status: "review" });
    expect(gateway.createCashfreeRefund).not.toHaveBeenCalled();
    expect(await resolveRefund(o.orderId, { paise: 48000 })).toBe(false);
    expect(await resolveRefund(o.orderId, { paise: 20000 })).toBe(true);
    expect(gateway.createCashfreeRefund).toHaveBeenCalledWith(expect.objectContaining({ amountRupees: 200 }));
    expect(await resolveRefund(o.orderId, { paise: 20000 })).toBe(false);
  });
});

describe("a seller cutting the bill on a paid order", () => {
  it("puts the difference in front of a person, and moves no money on its own", async () => {
    const o = await paidAndPlaced();
    const cut = fx("on_status_pending");
    // The seller could not supply the chicken topping (Rs 95): the bill drops to Rs 380.
    const q = cut.message.order.quote;
    const chicken = q.breakup.find((l: { title: string }) => l.title === "Pepper Barbeque Chicken");
    chicken.price.value = "0.00";
    q.price.value = "380.00";
    await reply("on_update", cut, { txnId: o.txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-21T10:05:00Z") }).expect(200);
    const view = await ondcOrderView(o.c.userId, o.orderId);
    expect(view.refund).toMatchObject({ status: "review" });
    expect(view.problem).toMatch(/from 475 to 380 rupees/);
    expect(gateway.createCashfreeRefund).not.toHaveBeenCalled();
    // The operator refunds exactly the difference.
    expect(await resolveRefund(o.orderId, { paise: 9500 })).toBe(true);
    expect(gateway.createCashfreeRefund).toHaveBeenCalledWith(expect.objectContaining({ amountRupees: 95 }));
  });
});

// An order can need more than one refund. Each used to be recorded only if no
// refund had happened yet, so once the first had gone through, a cancellation
// or a second cut to the bill was dropped and the customer never got it back.
describe("refunds that come in more than one step", () => {
  /** The seller's update with the given lines dropped from the bill. */
  function billWithout(...titles: string[]) {
    const update = fx("on_status_pending");
    const q = update.message.order.quote;
    let total = 475;
    for (const line of q.breakup) {
      if (titles.includes(line.title)) {
        total -= Number(line.price.value);
        line.price.value = "0.00";
      }
    }
    q.price.value = total.toFixed(2);
    return update;
  }
  function sellerCancelled() {
    const update = fx("on_status_pending");
    update.message.order.state = "Cancelled";
    update.message.order.cancellation = { cancelled_by: SELLER, reason: { id: "005" } };
    return update;
  }
  const at = (minute: number) => new Date(`2026-10-21T10:${String(minute).padStart(2, "0")}:00Z`);

  it("refunds the rest when the seller cancels after part of the bill went back", async () => {
    const o = await paidAndPlaced();
    await reply("on_update", billWithout("Pepper Barbeque Chicken"), { txnId: o.txnId, messageId: crypto.randomUUID(), at: at(5) }).expect(200);
    expect(await resolveRefund(o.orderId, { paise: 9500 })).toBe(true);
    expect(gateway.createCashfreeRefund).toHaveBeenLastCalledWith(expect.objectContaining({ refundId: `${o.gid}_refund_0_9500`, amountRupees: 95 }));

    await reply("on_status", sellerCancelled(), { txnId: o.txnId, messageId: crypto.randomUUID(), at: at(30) }).expect(200);
    expect(gateway.createCashfreeRefund).toHaveBeenLastCalledWith(expect.objectContaining({ refundId: `${o.gid}_refund_9500_38000`, amountRupees: 380 }));
    expect((await ondcOrderView(o.c.userId, o.orderId)).refund).toEqual({ status: "done", paise: 47500 });

    // The seller repeating itself refunds nothing more.
    await reply("on_status", sellerCancelled(), { txnId: o.txnId, messageId: crypto.randomUUID(), at: at(31) }).expect(200);
    expect(gateway.createCashfreeRefund).toHaveBeenCalledTimes(2);
  });

  it("asks a person again when the seller cuts the bill a second time", async () => {
    const o = await paidAndPlaced();
    await reply("on_update", billWithout("Pepper Barbeque Chicken"), { txnId: o.txnId, messageId: crypto.randomUUID(), at: at(5) }).expect(200);
    expect(await resolveRefund(o.orderId, { paise: 9500 })).toBe(true);

    await reply("on_update", billWithout("Pepper Barbeque Chicken", "Fresh Tomato"), { txnId: o.txnId, messageId: crypto.randomUUID(), at: at(10) }).expect(200);
    const view = await ondcOrderView(o.c.userId, o.orderId);
    expect(view.refund).toMatchObject({ status: "review" });
    expect(view.problem).toMatch(/to 345 rupees/);
    // No more than has not gone back yet: ₹475 paid, ₹95 already refunded.
    expect(await resolveRefund(o.orderId, { paise: 38001 })).toBe(false);
    expect(await resolveRefund(o.orderId, { paise: 3500 })).toBe(true);
    expect(gateway.createCashfreeRefund).toHaveBeenLastCalledWith(expect.objectContaining({ refundId: `${o.gid}_refund_9500_3500`, amountRupees: 35 }));
    expect((await ondcOrderView(o.c.userId, o.orderId)).refund).toEqual({ status: "done", paise: 13000 });
  });

  it("sends what came due while another refund was on its way", async () => {
    const o = await paidAndPlaced();
    await reply("on_update", billWithout("Pepper Barbeque Chicken"), { txnId: o.txnId, messageId: crypto.randomUUID(), at: at(5) }).expect(200);
    // The seller cancels while the operator's refund is still with the gateway.
    gateway.createCashfreeRefund.mockImplementationOnce(async () => {
      await reply("on_status", sellerCancelled(), { txnId: o.txnId, messageId: crypto.randomUUID(), at: at(30) }).expect(200);
      return { cf_refund_id: "rf_a", refund_id: "x", refund_status: "SUCCESS", refund_amount: 95 };
    });
    expect(await resolveRefund(o.orderId, { paise: 9500 })).toBe(true);
    expect(gateway.createCashfreeRefund).toHaveBeenCalledTimes(2);
    expect(gateway.createCashfreeRefund).toHaveBeenLastCalledWith(expect.objectContaining({ refundId: `${o.gid}_refund_9500_38000`, amountRupees: 380 }));
    expect((await ondcOrderView(o.c.userId, o.orderId)).refund).toEqual({ status: "done", paise: 47500 });
  });
});

describe("paying the seller app", () => {
  it("records what is owed once the order is delivered: the total less the finder fee, after the window", async () => {
    const confirmed = fx("on_confirm");
    confirmed.message.order.payment["@ondc/org/settlement_basis"] = "delivery";
    const o = await paidAndPlaced(confirmed);
    const delivered = new Date("2026-10-21T11:00:00Z");
    await reply("on_status", fx("on_status_delivered"), { txnId: o.txnId, messageId: crypto.randomUUID(), at: delivered }).expect(200);
    const payout = await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: o.orderId } });
    expect(payout).toMatchObject({ bppId: SELLER, orderTotalPaise: 47500, feePaise: 1425, amountPaise: 46075, status: "due", settlementWindow: "P3D" });
    expect(payout.dueAt.toISOString()).toBe("2026-10-24T11:00:00.000Z");
    // A repeated delivery report records nothing more.
    await reply("on_status", fx("on_status_delivered"), { txnId: o.txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-21T11:05:00Z") }).expect(200);
    expect(await prisma.ondcPayout.count({ where: { ondcOrderId: o.orderId } })).toBe(1);

    // The operator records the bank transfer once.
    expect(await markPayoutPaid(payout.id, "op_1", "UTR12345678")).toBe(true);
    expect(await markPayoutPaid(payout.id, "op_1", "UTR12345678")).toBe(false);
  });

  it("holds a payout due after the seller's return window for a person to date", async () => {
    const o = await paidAndPlaced();
    await reply("on_status", fx("on_status_delivered"), { txnId: o.txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-21T11:00:00Z") }).expect(200);
    expect(await prisma.ondcPayout.findUniqueOrThrow({ where: { ondcOrderId: o.orderId } })).toMatchObject({ status: "held", settlementBasis: "return_window_expiry" });
  });

  it("reads settlement windows", () => {
    expect(durationMs("P3D")).toBe(3 * 86_400_000);
    expect(durationMs("PT12H")).toBe(12 * 3_600_000);
    expect(durationMs("P1DT2H30M")).toBe((26 * 60 + 30) * 60_000);
    expect(durationMs("3 days")).toBeNull();
    expect(durationMs("P")).toBeNull();
  });
});
