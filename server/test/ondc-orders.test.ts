import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter } from "../src/modules/ondc/callbacks.routes.js";
import { recordInbound } from "../src/modules/ondc/index.js";
import { readQuote } from "../src/modules/ondc/orderReplies.js";
import {
  cancelOndcOrder,
  confirmOndcOrder,
  initOndcOrder,
  markOndcOrderPaid,
  ondcOrderView,
  startOndcOrder,
  trackOndcOrder,
  type OrderDeps,
} from "../src/modules/ondc/orders.service.js";
import { startOndcSearch } from "../src/modules/ondc/search.service.js";
import { authedAgent } from "./helpers.js";

// A food order with an ONDC seller, end to end: ONDC's mock seller (Pramaan)
// answers every step with the replies from a certified buyer app flow,
// signed, through the real callbacks endpoint, and the order moves from a
// price check to delivered. Personal details in those replies are replaced.

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ondc-ret11/${name}.json`, import.meta.url), "utf8")) as any;
const SELLER = "pramaan.ondc.org/beta/preprod/mock/seller";
const SELLER_URI = "https://pramaan.ondc.org/beta/preprod/mock/seller";

const key = crypto.generateKeyPairSync("ed25519");
const sellerKey = {
  priv: key.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
  pub: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
};
const ourKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
const identity = () => ({ subscriberId: "ondc.flouna.com", uniqueKeyId: "k", signingPrivateKey: ourKey });

const callbacks = express();
callbacks.use(express.json({ limit: "5mb", verify: (req, _res, buf) => void ((req as express.Request & { rawBody?: Buffer }).rawBody = buf) }));
callbacks.use(createCallbacksRouter({ publicKeyFor: async () => sellerKey.pub, record: recordInbound }));

/** The seller app sending a signed message to our callback endpoint. */
function reply(action: string, message: any, ctx: { txnId: string; messageId: string; from?: string; at?: Date }) {
  const from = ctx.from ?? SELLER;
  message.context = {
    ...message.context,
    action,
    bap_id: "ondc.flouna.com",
    bap_uri: "https://ondc.flouna.com/ondc",
    bpp_id: from,
    transaction_id: ctx.txnId,
    message_id: ctx.messageId,
    timestamp: (ctx.at ?? new Date()).toISOString(),
  };
  const body = JSON.stringify(message);
  return request(callbacks)
    .post(`/ondc/${action}`)
    .set("Content-Type", "application/json")
    .set("Authorization", createAuthorizationHeader(body, { subscriberId: from, uniqueKeyId: "s", signingPrivateKey: sellerKey.priv }))
    .send(body);
}

type Sent = { url: string; action: string; envelope: any };
function recorder(ack = true) {
  const sent: Sent[] = [];
  const deps: OrderDeps = {
    identity,
    send: async (url, action, envelope) => {
      sent.push({ url, action, envelope });
      return ack ? { ack: true, status: 200 } : { ack: false, status: 500 };
    },
  };
  return { sent, deps, last: () => sent[sent.length - 1]! };
}

/** A customer in New Delhi near the mock store, who has searched and had the store answer. */
async function customerWithSearch() {
  const signedUp = await authedAgent({ withAddress: false });
  const user = await prisma.user.findUniqueOrThrow({ where: { email: signedUp.email } });
  await prisma.address.create({
    data: {
      userId: user.id,
      label: "Home",
      line1: "1 Test Street",
      line2: "Test Layout",
      contactName: "Test Customer",
      contactPhone: "+91 90000 00001",
      city: "New Delhi",
      state: "Delhi",
      pincode: "110030",
      lat: 28.5355,
      lng: 77.191,
      isDefault: true,
    },
  });
  const started = await startOndcSearch(user.id, "pizza", { identity, send: async () => ({ ack: true, status: 200 }) });
  const searchId = (started as { searchId: string }).searchId;
  await reply("on_search", fx("on_search_pramaan"), { txnId: searchId, messageId: crypto.randomUUID() }).expect(200);
  return { ...signedUp, userId: user.id, searchId };
}

const PIZZA = {
  itemId: "id_ancc5_0_0",
  count: 1,
  parentItemId: "c6f65dd7e0",
  customizations: [
    { itemId: "id_1bai73_1_0", groupId: "CG11" },
    { itemId: "id_c2egb_3_0", groupId: "CG21" },
    { itemId: "id_12xdek_6_0", groupId: "CG31" },
    { itemId: "id_16vmqe_8_0", groupId: "CG31" },
  ],
};

async function startPizza(c: { userId: string; searchId: string }, deps: OrderDeps) {
  return startOndcOrder(c.userId, { searchId: c.searchId, bppId: SELLER, providerId: "pramaan_provider_1", locationId: "SSL1", lines: [PIZZA] }, deps);
}

/** Runs the order up to placed, returning what was sent. */
async function placedOrder() {
  const c = await customerWithSearch();
  const r = recorder();
  const { orderId } = await startPizza(c, r.deps);
  const order = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: orderId } });
  await reply("on_select", fx("on_select"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
  await initOndcOrder(c.userId, orderId, r.deps);
  await reply("on_init", fx("on_init"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id }).expect(200);
  await markOndcOrderPaid(orderId, { amountPaise: 47500, reference: "pay_1" });
  await confirmOndcOrder(c.userId, orderId, r.deps);
  await reply("on_confirm", fx("on_confirm"), { txnId: order.txnId, messageId: r.last().envelope.context.message_id, at: new Date("2026-10-21T10:00:00Z") }).expect(200);
  return { c, r, orderId, txnId: order.txnId };
}

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
      // Payment is not connected for ONDC orders outside demo mode.
      await c.agent.post(`/api/ondc/orders/${orderId}/pay`).expect(501);
    } finally {
      env.ONDC_SEARCH_ENABLED = false;
    }
  });
});
