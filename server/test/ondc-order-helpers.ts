import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter } from "../src/modules/ondc/callbacks.routes.js";
import { recordInbound } from "../src/modules/ondc/index.js";
import { confirmOndcOrder, initOndcOrder, markOndcOrderPaid, startOndcOrder, type OrderDeps } from "../src/modules/ondc/orders.service.js";
import { startOndcSearch } from "../src/modules/ondc/search.service.js";
import { authedAgent } from "./helpers.js";

// Shared by the ONDC order and payment tests: ONDC's mock seller (Pramaan)
// answering with the replies from a certified buyer app flow, signed, through
// the real callbacks endpoint. Personal details in those replies are replaced.

export const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ondc-ret11/${name}.json`, import.meta.url), "utf8")) as any;
export const SELLER = "pramaan.ondc.org/beta/preprod/mock/seller";
export const SELLER_URI = "https://pramaan.ondc.org/beta/preprod/mock/seller";

const key = crypto.generateKeyPairSync("ed25519");
const sellerKey = {
  priv: key.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
  pub: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
};
const ourKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
export const identity = () => ({ subscriberId: "ondc.flouna.com", uniqueKeyId: "k", signingPrivateKey: ourKey });

export const callbacks = express();
callbacks.use(express.json({ limit: "5mb", verify: (req, _res, buf) => void ((req as express.Request & { rawBody?: Buffer }).rawBody = buf) }));
callbacks.use(createCallbacksRouter({ publicKeyFor: async () => sellerKey.pub, record: recordInbound }));

/** The seller app sending a signed message to our callback endpoint. */
export function reply(action: string, message: any, ctx: { txnId: string; messageId: string; from?: string; at?: Date }) {
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

export type Sent = { url: string; action: string; envelope: any };
export function recorder(ack = true) {
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
export async function customerWithSearch() {
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

export const PIZZA = {
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

export async function startPizza(c: { userId: string; searchId: string }, deps: OrderDeps) {
  return startOndcOrder(c.userId, { searchId: c.searchId, bppId: SELLER, providerId: "pramaan_provider_1", locationId: "SSL1", lines: [PIZZA] }, deps);
}

/** Runs the order up to placed, returning what was sent. */
export async function placedOrder() {
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
