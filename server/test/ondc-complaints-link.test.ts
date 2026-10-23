import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { NetworkIgmAdapter, igmRefFor } from "../src/modules/complaints/igm.network.js";
import { authedAgent } from "./helpers.js";

// A complaint about an order placed through ONDC itself (a food order with an
// ONDC seller, or a ride with an ONDC provider) reaches that seller as an IGM
// issue naming the seller's own order id. Before this, only app orders that
// carried ONDC details could be complained about over the network.

const ourKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
const sent: { url: string; action: string; envelope: { context: Record<string, unknown>; message: unknown } }[] = [];
const adapter = new NetworkIgmAdapter({
  identity: () => ({ subscriberId: "ondc.flouna.com", uniqueKeyId: "k", signingPrivateKey: ourKey }),
  send: async (url, action, envelope) => {
    sent.push({ url, action, envelope });
    return { ack: true, status: 200 };
  },
});

async function customer() {
  const signedUp = await authedAgent();
  const user = await prisma.user.update({ where: { email: signedUp.email }, data: { phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}` } });
  return { ...signedUp, userId: user.id };
}

const SELLER = { bppId: "seller.example", bppUri: "https://seller.example/ondc" };

function foodOrder(userId: string, placed = true) {
  return prisma.ondcOrder.create({
    data: {
      userId,
      txnId: crypto.randomUUID(),
      status: placed ? "placed" : "quoted",
      ...SELLER,
      providerId: "P1",
      locationId: "L1",
      storeName: "Test Store",
      city: "std:080",
      lines: JSON.stringify([{ itemId: "I1", count: 2 }]),
      fulfillmentId: "F1",
      ...(placed ? { sellerOrderId: "SELLER-ORDER-9", sellerState: "Accepted" } : {}),
    },
  });
}

describe("complaints about orders placed through ONDC", () => {
  it("sends a complaint about an ONDC food order to its seller, naming the seller's order", async () => {
    const c = await customer();
    const order = await foodOrder(c.userId);
    const res = await c.agent
      .post("/api/complaints")
      .send({ orderId: order.id, category: "ORDER", subCategory: "WRONG_ITEM_DELIVERED", description: "Got the wrong dish" })
      .expect(201);
    const before = sent.length;
    expect(await adapter.sendIssue(res.body.complaint.id)).toEqual({ sent: true });
    const issue = sent[before]!;
    expect(issue.url).toBe(SELLER.bppUri);
    expect(issue.envelope.context).toMatchObject({ domain: "ONDC:RET11", transaction_id: order.txnId, bpp_id: SELLER.bppId });
    const body = JSON.stringify(issue.envelope.message);
    expect(body).toContain("SELLER-ORDER-9");
    expect(body).not.toContain(order.id);
  });

  it("sends a complaint about an ONDC ride to its provider", async () => {
    const c = await customer();
    const ride = await prisma.ondcRide.create({
      data: {
        userId: c.userId,
        txnId: crypto.randomUUID(),
        status: "completed",
        city: "std:080",
        pickup: "{}",
        drop: "{}",
        ...SELLER,
        providerId: "P1",
        itemId: "I1",
        fulfillmentId: "F1",
        sellerOrderId: "RIDE-ORDER-3",
      },
    });
    expect(await igmRefFor(ride.id)).toMatchObject({ domain: "ONDC:TRV10", orderId: "RIDE-ORDER-3", items: [{ id: "I1", count: 1 }] });
  });

  it("holds a complaint about an order the seller has not accepted, rather than send one it cannot look up", async () => {
    const c = await customer();
    const order = await foodOrder(c.userId, false);
    expect(await igmRefFor(order.id)).toBeNull();
    const res = await c.agent.post("/api/complaints").send({ orderId: order.id, category: "ORDER", subCategory: "WRONG_ITEM_DELIVERED", description: "Never came" }).expect(201);
    expect((await adapter.sendIssue(res.body.complaint.id)).sent).toBe(false);
  });

  it("refuses a complaint about someone else's ONDC order", async () => {
    const owner = await customer();
    const order = await foodOrder(owner.userId);
    const stranger = await customer();
    await stranger.agent.post("/api/complaints").send({ orderId: order.id, category: "ORDER", subCategory: "WRONG_ITEM_DELIVERED", description: "Not mine" }).expect(404);
  });
});

// From the review on #85: a food order's stored lines were parsed without a
// guard, and only two of the fields the issue names were checked.
describe("an ONDC complaint reference that cannot be built", () => {
  it("holds the complaint rather than crash on lines that do not parse", async () => {
    const c = await customer();
    const order = await foodOrder(c.userId);
    await prisma.ondcOrder.update({ where: { id: order.id }, data: { lines: "not json" } });
    expect(await igmRefFor(order.id)).toBeNull();
  });

  it("holds it rather than send an issue with a field missing", async () => {
    const c = await customer();
    const order = await foodOrder(c.userId);
    await prisma.ondcOrder.update({ where: { id: order.id }, data: { providerId: "" } });
    expect(await igmRefFor(order.id)).toBeNull();
  });
});
