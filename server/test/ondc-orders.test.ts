import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { readQuote } from "../src/modules/ondc/orderReplies.js";
import {
  cancelOndcOrder,
  confirmOndcOrder,
  initOndcOrder,
  markOndcOrderPaid,
  ondcOrderView,
  startOndcOrder,
  trackOndcOrder,
} from "../src/modules/ondc/orders.service.js";
import { authedAgent, consoleAgent } from "./helpers.js";
import { customerWithSearch, fx, placedOrder, recorder, reply, SELLER, SELLER_URI, startPizza, withPublishedTerms } from "./ondc-order-helpers.js";

// A food order with an ONDC seller, end to end: ONDC's mock seller (Pramaan)
// answers every step with the replies from a certified buyer app flow,
// signed, through the real callbacks endpoint, and the order moves from a
// price check to delivered. Personal details in those replies are replaced.

describe("ordering food from an ONDC seller", () => {
  it("prices, initialises, confirms and follows an order to delivery with the seller's signed replies", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const { orderId } = await startPizza(c, r.deps);
    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: orderId } });

    // select goes to the seller app itself, on a transaction of its own.
    expect(r.last().url).toBe(`${SELLER_URI}/select`);
    expect(r.last().envelope.context).toMatchObject({ action: "select", bpp_id: SELLER, transaction_id: order.txnId, city: "std:011" });
    expect(order.txnId).not.toBe(c.searchId);
    expect(r.last().envelope.message.order.items).toHaveLength(5);
    expect((await ondcOrderView(c.userId, orderId)).status).toBe("selecting");

    await reply("on_select", fx("on_select"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    let view = await ondcOrderView(c.userId, orderId);
    expect(view).toMatchObject({ status: "quoted", totalPaise: 47500, store: "Pramaan Store 1" });
    expect(view.quote!.lines.map((l) => l.type)).toEqual(["item", "item", "item", "item", "item", "delivery", "misc"]);

    await initOndcOrder(c.userId, orderId, r.deps);
    expect(r.last().action).toBe("init");
    const init = r.last().envelope.message.order;
    expect(init.fulfillments[0].id).toBe("2859f1ca-bc0a-4ad5-8ee5-e7374f7aa109");
    // The receiver's own contact, with the phone in the 10 digit form sellers read.
    expect(init.fulfillments[0].end.contact.phone).toBe("9000000001");
    expect(init.billing.name).toBe("Test User");
    // Every item, add-ons included, goes with the fulfillment the seller gave it in on_select.
    expect(init.items.map((i: { fulfillment_id: string }) => i.fulfillment_id)).toEqual(Array(5).fill("2859f1ca-bc0a-4ad5-8ee5-e7374f7aa109"));

    await reply("on_init", fx("on_init"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    view = await ondcOrderView(c.userId, orderId);
    expect(view.status).toBe("ready_to_pay");

    // Confirming before paying is refused, and so is paying a different amount.
    await expect(confirmOndcOrder(c.userId, orderId, r.deps)).rejects.toThrow(/ready_to_pay, not ready to place/);
    await expect(markOndcOrderPaid(orderId, { amountPaise: 47000, reference: "pay_x" })).rejects.toThrow(/does not match/);
    await markOndcOrderPaid(orderId, { amountPaise: 47500, reference: "pay_1" });

    await confirmOndcOrder(c.userId, orderId, r.deps);
    const confirm = r.last().envelope.message.order;
    expect(confirm.payment).toMatchObject({ collected_by: "BAP", status: "PAID", params: { amount: "475.00", transaction_id: "pay_1" } });
    // The seller's quote and settlement details go back exactly as it sent them.
    expect(confirm.quote).toEqual(fx("on_init").message.order.quote);
    expect(confirm.payment["@ondc/org/settlement_details"]).toEqual(fx("on_init").message.order.payment["@ondc/org/settlement_details"]);
    // So do the seller's terms; ours carry our GSTIN, as ONDC's validator requires of a confirm.
    expect(confirm.tags).toEqual([
      fx("on_init").message.order.tags.find((t: { code: string }) => t.code === "bpp_terms"),
      { code: "bap_terms", list: [{ code: "tax_number", value: process.env.ONDC_BAP_GSTIN }] },
    ]);
    expect(confirm.items.map((i: { fulfillment_id: string }) => i.fulfillment_id)).toEqual(Array(5).fill("2859f1ca-bc0a-4ad5-8ee5-e7374f7aa109"));

    await reply("on_confirm", fx("on_confirm"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id, at: new Date("2026-10-21T10:00:00Z") }).expect(200);
    view = await ondcOrderView(c.userId, orderId);
    expect(view).toMatchObject({ status: "placed", sellerOrderId: "18452cfae6794f3bb2206e609c413709", sellerState: "Accepted", fulfillmentState: "Pending", paid: true });

    // The seller then reports progress unasked, each with a new message id.
    let t = Date.parse("2026-10-21T10:00:00Z");
    for (const [name, state, fulfilment] of [
      ["on_status_pending", "In-progress", "Packed"],
      ["on_status_out_for_delivery", "In-progress", "Out-for-delivery"],
      ["on_status_delivered", "Completed", "Order-delivered"],
    ] as const) {
      t += 60_000;
      await reply("on_status", fx(name), { txnId: order.txnId, messageId: crypto.randomUUID(), at: new Date(t) }).expect(200);
      expect(await ondcOrderView(c.userId, orderId)).toMatchObject({ sellerState: state, fulfillmentState: fulfilment });
    }
  });

  it("ignores a reply signed by any seller other than the one the order is with", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const { orderId } = await startPizza(c, r.deps);
    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: orderId } });
    // Genuinely signed, by another registered seller app, naming our transaction.
    await reply("on_select", fx("on_select"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id, from: "other.seller.example" }).expect(200);
    expect((await ondcOrderView(c.userId, orderId)).status).toBe("selecting");
  });

  it("ignores a reply that does not answer the request we are waiting on", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const { orderId } = await startPizza(c, r.deps);
    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: orderId } });
    await reply("on_select", fx("on_select"), { txnId: order.txnId, messageId: crypto.randomUUID() }).expect(200);
    expect((await ondcOrderView(c.userId, orderId)).status).toBe("selecting");
    // And an on_init before any init was sent changes nothing either.
    await reply("on_init", fx("on_init"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    expect((await ondcOrderView(c.userId, orderId)).status).toBe("selecting");
  });

  it("does not let a slow, older status overwrite a newer one", async () => {
    const { c, orderId, txnId } = await placedOrder();
    await reply("on_status", fx("on_status_delivered"), { txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-21T10:30:00Z") }).expect(200);
    await reply("on_status", fx("on_status_pending"), { txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-21T10:05:00Z") }).expect(200);
    expect(await ondcOrderView(c.userId, orderId)).toMatchObject({ sellerState: "Completed", fulfillmentState: "Order-delivered" });
  });

  it("ignores a status update about a different seller order id", async () => {
    const { c, orderId, txnId } = await placedOrder();
    const other = fx("on_status_delivered");
    other.message.order.id = "someone-elses-order";
    await reply("on_status", other, { txnId, messageId: crypto.randomUUID(), at: new Date("2026-10-21T11:00:00Z") }).expect(200);
    expect((await ondcOrderView(c.userId, orderId)).sellerState).toBe("Accepted");
  });

  it("only starts an order for a store and dish that were in the customer's search results", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    await expect(
      startOndcOrder(c.userId, { searchId: c.searchId, bppId: SELLER, providerId: "pramaan_provider_1", locationId: "SSL1", lines: [{ itemId: "not_on_menu", count: 1 }] }, r.deps),
    ).rejects.toThrow(/not on that store's menu/);
    await expect(
      startOndcOrder(c.userId, { searchId: c.searchId, bppId: "other.seller.example", providerId: "p", locationId: "l", lines: [{ itemId: "x", count: 1 }] }, r.deps),
    ).rejects.toThrow(/not in your search results/);
    // Someone else's search is not found at all.
    const stranger = await customerWithSearch();
    await expect(startPizza({ userId: stranger.userId, searchId: c.searchId }, r.deps)).rejects.toThrow(/Search not found/);
    expect(r.sent).toHaveLength(0);
  });

  it("starts no order while our GSTIN is unset, since it could be paid for and never placed", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const saved = process.env.ONDC_BAP_GSTIN;
    delete process.env.ONDC_BAP_GSTIN;
    try {
      await expect(startPizza(c, r.deps)).rejects.toThrow(/not set up/);
    } finally {
      process.env.ONDC_BAP_GSTIN = saved;
    }
    expect(r.sent).toHaveLength(0);
    expect(await prisma.ondcOrder.count({ where: { userId: c.userId } })).toBe(0);
  });

  it("says so when the seller would split the cart across deliveries, rather than send items the wrong one", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const { orderId } = await startPizza(c, r.deps);
    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: orderId } });
    const split = fx("on_select");
    split.message.order.items[0].fulfillment_id = "another-fulfillment";
    await reply("on_select", split, { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    const view = await ondcOrderView(c.userId, orderId);
    expect(view.status).toBe("unavailable");
    expect(view.problem).toMatch(/in parts/);
  });

  it("says the store is unavailable when its app refuses the select", async () => {
    const c = await customerWithSearch();
    const r = recorder(false);
    const { orderId } = await startPizza(c, r.deps);
    const view = await ondcOrderView(c.userId, orderId);
    expect(view.status).toBe("unavailable");
    expect(view.problem).toMatch(/did not accept/);
  });

  it("shows out of stock items from on_select rather than a price for them", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const { orderId } = await startPizza(c, r.deps);
    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: orderId } });
    const short = fx("on_select");
    short.error = { type: "DOMAIN-ERROR", code: "40002", message: "[{\"item_id\":\"id_ancc5_0_0\",\"error\":\"40002\"}]" };
    short.message.order.quote.breakup[0].item.quantity.available.count = "0";
    await reply("on_select", short, { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    const view = await ondcOrderView(c.userId, orderId);
    expect(view.status).toBe("unavailable");
    expect(view.problem).toBe("Out of stock: Farmhouse Pizza");
  });

  it("cancels with the seller, and keeps the order when the seller refuses", async () => {
    const { c, r, orderId, txnId } = await placedOrder();
    await cancelOndcOrder(c.userId, orderId, "006", r.deps);
    expect(r.last().envelope.message).toEqual({ order_id: "18452cfae6794f3bb2206e609c413709", cancellation_reason_id: "006" });
    expect((await ondcOrderView(c.userId, orderId)).status).toBe("cancelling");

    // The seller answers without cancelling: the order carries on.
    const refused = fx("on_status_pending");
    await reply("on_cancel", refused, { txnId, messageId: r.last().envelope.context.message_id, at: new Date("2026-10-21T10:10:00Z") }).expect(200);
    let view = await ondcOrderView(c.userId, orderId);
    expect(view.status).toBe("placed");
    expect(view.problem).toMatch(/did not agree to cancel/);

    // Asked again, the seller cancels.
    await cancelOndcOrder(c.userId, orderId, "006", r.deps);
    const cancelled = fx("on_status_pending");
    cancelled.message.order.state = "Cancelled";
    cancelled.message.order.fulfillments[0].state.descriptor.code = "Cancelled";
    cancelled.message.order.cancellation = { cancelled_by: SELLER, reason: { id: "006" } };
    await reply("on_cancel", cancelled, { txnId, messageId: r.last().envelope.context.message_id, at: new Date("2026-10-21T10:20:00Z") }).expect(200);
    view = await ondcOrderView(c.userId, orderId);
    expect(view).toMatchObject({ status: "cancelled", sellerState: "Cancelled", fulfillmentState: "Cancelled" });
    await expect(cancelOndcOrder(c.userId, orderId, "006", r.deps)).rejects.toThrow(/cancelled and cannot be cancelled/);
  });

  it("records a paid order the seller would not accept as failed, so it is refunded", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const { orderId } = await startPizza(c, r.deps);
    const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: orderId } });
    await reply("on_select", fx("on_select"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    await initOndcOrder(c.userId, orderId, r.deps);
    await reply("on_init", fx("on_init"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    await markOndcOrderPaid(orderId, { amountPaise: 47500, reference: "pay_1" });
    await confirmOndcOrder(c.userId, orderId, r.deps);
    const rejected = fx("on_confirm");
    rejected.message.order.state = "Cancelled";
    await reply("on_confirm", rejected, { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    const view = await ondcOrderView(c.userId, orderId);
    expect(view).toMatchObject({ status: "failed", paid: true });
    expect(view.problem).toMatch(/did not accept/);
  });

  it("shows the tracking link only from the order's own seller", async () => {
    const { c, r, orderId, txnId } = await placedOrder();
    expect((await ondcOrderView(c.userId, orderId)).tracking).toBeNull();
    await trackOndcOrder(c.userId, orderId, r.deps);
    expect(r.last()).toMatchObject({ url: `${SELLER_URI}/track`, envelope: { message: { order_id: "18452cfae6794f3bb2206e609c413709" } } });
    // Another seller app, validly signed, offering a link for our order.
    const forged = { message: { tracking: { url: "https://phish.example/track", status: "active" } } };
    await reply("on_track", forged, { txnId, messageId: r.last().envelope.context.message_id, from: "other.seller.example" }).expect(200);
    expect((await ondcOrderView(c.userId, orderId)).tracking).toBeNull();
    const genuine = { message: { tracking: { url: "https://seller.example.com/track/1", status: "active" } } };
    await reply("on_track", genuine, { txnId, messageId: r.last().envelope.context.message_id }).expect(200);
    expect((await ondcOrderView(c.userId, orderId)).tracking).toEqual({ url: "https://seller.example.com/track/1", status: "active" });
  });

  it("refuses a quote whose lines do not add up to its total", () => {
    const q = structuredClone(fx("on_select").message.order.quote);
    q.price.value = "500.00";
    expect(readQuote(q)).toEqual({ problem: expect.stringMatching(/add up to 475 but the total says 500/) });
    q.price.value = "abc";
    expect(readQuote(q)).toEqual({ problem: "The seller's quote has no valid total" });
  });
});

describe("the ONDC order routes", () => {
  it("are hidden while ONDC is off, and serve the customer's own orders when on", async () => {
    const c = await customerWithSearch();
    const r = recorder();
    const { orderId } = await startPizza(c, r.deps);
    await c.agent.get(`/api/ondc/orders/${orderId}`).expect(404);
    env.ONDC_SEARCH_ENABLED = true;
    try {
      const res = await c.agent.get(`/api/ondc/orders/${orderId}`).expect(200);
      expect(res.body).toMatchObject({ id: orderId, status: "selecting" });
      const stranger = await authedAgent();
      await stranger.agent.get(`/api/ondc/orders/${orderId}`).expect(404);
      await c.agent.post(`/api/ondc/orders/${orderId}/cancel`).send({ reasonId: "999" }).expect(400);
      // Nothing to pay until the seller has given its final total.
      await c.agent.post(`/api/ondc/orders/${orderId}/pay`).expect(409);
    } finally {
      env.ONDC_SEARCH_ENABLED = false;
    }
  });
});

describe("which version of our static terms each seller app accepted (static terms 17.6.1)", () => {
  const TERMS = { termsUrl: "https://flouna.com/ondc/static_terms_v1.0.1.pdf", termsEffective: "2026-11-01T00:00:00.000Z" };

  it("records the seller app, the version, when and the signed on_confirm that accepted it", async () => {
    await prisma.ondcTermsAcceptance.deleteMany({ where: { bppId: SELLER } });
    const first = await withPublishedTerms(() => placedOrder());
    const row = await prisma.ondcTermsAcceptance.findUniqueOrThrow({ where: { bppId_termsUrl_termsEffective: { bppId: SELLER, ...TERMS } } });
    expect(row).toMatchObject({
      firstOrderId: first.orderId,
      firstMessageId: first.confirmMessageId,
      firstAcceptedAt: new Date("2026-10-21T10:00:00Z"),
      ordersAccepted: 1,
      statedAccept: false,
    });
    // The signed message it points to is in the transaction log.
    expect(await prisma.ondcTransaction.count({ where: { messageId: first.confirmMessageId, action: "on_confirm" } })).toBeGreaterThan(0);

    // A later order under the same version counts against the same record and keeps the first as the evidence.
    await withPublishedTerms(() => placedOrder((m) => m.message.order.tags[0].list.push({ code: "accept_bap_terms", value: "Y" })));
    const after = await prisma.ondcTermsAcceptance.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ firstOrderId: first.orderId, ordersAccepted: 2, statedAccept: true });
  });

  it("records nothing for an order whose search stated no terms, or that the seller did not accept", async () => {
    await prisma.ondcTermsAcceptance.deleteMany({ where: { bppId: SELLER } });
    await placedOrder();
    expect(await prisma.ondcTermsAcceptance.count({ where: { bppId: SELLER } })).toBe(0);
    await withPublishedTerms(() => placedOrder((m) => (m.message.order.state = "Cancelled")));
    expect(await prisma.ondcTermsAcceptance.count({ where: { bppId: SELLER } })).toBe(0);
  });

  it("is listed for admins only", async () => {
    const admin = await consoleAgent("admin");
    const res = await admin.agent.get("/api/console/admin/ondc/terms-acceptances").expect(200);
    expect(Array.isArray(res.body.acceptances)).toBe(true);
    const user = await authedAgent();
    // The console answers anyone else as if it did not exist.
    await user.agent.get("/api/console/admin/ondc/terms-acceptances").expect(404);
  });
});
