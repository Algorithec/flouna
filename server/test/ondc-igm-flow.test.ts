import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter } from "../src/modules/ondc/callbacks.routes.js";
import { recordInbound } from "../src/modules/ondc/index.js";
import { NetworkIgmAdapter, ondcOrderRef } from "../src/modules/complaints/igm.network.js";
import { authedAgent } from "./helpers.js";

// A complaint about an ONDC order, end to end against the database: raised by
// the customer, sent to the seller app as a signed issue, then moved along by
// the seller's own on_issue answers arriving at /ondc/on_issue. The answers
// are the Pramaan mock seller's messages from a certified flow, re-addressed
// to this complaint's issue.

const SELLER = "pramaan.ondc.org/beta/preprod/mock/seller";
const kp = crypto.generateKeyPairSync("ed25519");
const sellerKey = {
  priv: kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
  pub: kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
};
const intruderKp = crypto.generateKeyPairSync("ed25519");
const intruderKey = intruderKp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
const ourKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");

const pramaan = JSON.parse(readFileSync(new URL("./fixtures/ondc-igm2-pramaan-on_issue.json", import.meta.url), "utf8")) as Record<
  string,
  { context: Record<string, unknown>; message: { issue: Record<string, unknown> } }
>;

const ondc = {
  domain: "ONDC:RET11",
  city: "std:080",
  transactionId: "txn-igm-1",
  bpp: { id: SELLER, uri: "https://pramaan.ondc.org/beta/preprod/mock/seller" },
  orderId: "ONDC-ORDER-1",
  providerId: "pramaan_provider_1",
  fulfillmentId: "F1",
  items: [{ id: "I1", count: 1 }],
};

const sent: { url: string; action: string; envelope: { context: Record<string, unknown>; message: { issue: Record<string, unknown> } } }[] = [];
const adapter = new NetworkIgmAdapter({
  identity: () => ({ subscriberId: "ondc.flouna.com", uniqueKeyId: "k", signingPrivateKey: ourKey }),
  send: async (url, action, envelope) => {
    sent.push({ url, action, envelope: envelope as (typeof sent)[number]["envelope"] });
    return { ack: true, status: 200 };
  },
});

const callbacks = express();
callbacks.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
callbacks.use(
  createCallbacksRouter({
    publicKeyFor: async (s) => (s === SELLER ? sellerKey.pub : s === "intruder.test" ? intruderKp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64") : null),
    record: recordInbound,
  }),
);

/** A Pramaan on_issue, re-addressed to our issue and freshly stamped. */
function sellerMessage(name: string, issueId: string, bppId = SELLER) {
  const m = structuredClone(pramaan[name]!);
  m.context = { ...m.context, bpp_id: bppId, message_id: crypto.randomUUID(), timestamp: new Date().toISOString() };
  m.message.issue.id = issueId;
  return JSON.stringify(m);
}
const deliver = (body: string, sub = SELLER, key = sellerKey.priv) =>
  request(callbacks)
    .post("/ondc/on_issue")
    .set("Content-Type", "application/json")
    .set("Authorization", createAuthorizationHeader(body, { subscriberId: sub, uniqueKeyId: "s1", signingPrivateKey: key }))
    .send(body);

let agent: Awaited<ReturnType<typeof authedAgent>>["agent"];
let complaintId: string;
let issueId: string;

const complaint = () =>
  prisma.complaint.findUniqueOrThrow({ where: { id: complaintId }, include: { actions: true, resolutions: true } });

beforeAll(async () => {
  const signedUp = await authedAgent();
  agent = signedUp.agent;
  const user = await prisma.user.update({ where: { email: signedUp.email }, data: { phone: `9${String(Date.now()).slice(-9)}` } });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      domain: "food",
      title: "Paneer biryani",
      provider: "ondc",
      fulfillment: "in_app",
      amount: 25000,
      status: "confirmed",
      details: JSON.stringify({ ondc }),
    },
  });
  const res = await agent
    .post("/api/complaints")
    .send({ orderId: order.id, category: "ORDER", subCategory: "WRONG_ITEM_DELIVERED", description: "Got paneer instead of chicken" })
    .expect(201);
  complaintId = res.body.complaint.id;
});

describe("ONDC complaint, end to end", () => {
  it("reads the ONDC details an order carries, and nothing from an order that has none", () => {
    expect(ondcOrderRef(JSON.stringify({ ondc }))).toMatchObject({ transactionId: "txn-igm-1", bpp: { id: SELLER } });
    expect(ondcOrderRef("{}")).toBeNull();
    expect(ondcOrderRef("not json")).toBeNull();
    expect(ondcOrderRef(JSON.stringify({ ondc: { ...ondc, bpp: { id: SELLER } } }))).toBeNull();
  });

  it("sends the complaint to the seller app as a signed issue", async () => {
    expect(await adapter.sendIssue(complaintId)).toEqual({ sent: true });
    const out = sent.at(-1)!;
    expect(out.url).toBe(ondc.bpp.uri);
    expect(out.action).toBe("issue");
    const issue = out.envelope.message.issue;
    expect(issue.descriptor).toMatchObject({ code: "ITM03", long_desc: "Got paneer instead of chicken" });
    expect(issue.refs).toContainEqual({ ref_id: "ONDC-ORDER-1", ref_type: "ORDER" });
    const c = await complaint();
    expect(c.ondcIssueId).toBe(issue.id);
    expect(c.ondcTransactionId).toBe("txn-igm-1");
    issueId = c.ondcIssueId!;
  });

  it("applies the seller's acknowledgement", async () => {
    await deliver(sellerMessage("on_issue_processing_1", issueId)).expect(200);
    const c = await complaint();
    expect(c.status).toBe("PROCESSING");
    expect(c.actions.some((a) => a.code === "ACKNOWLEDGED" && a.actionBy === "SELLER-NP")).toBe(true);
  });

  it("shows the seller's request for information to the customer", async () => {
    await deliver(sellerMessage("on_issue_info_required", issueId)).expect(200);
    const c = await complaint();
    expect(c.infoRequest).toBe("Provide product image");
    expect(c.infoRequestedAt).not.toBeNull();
  });

  it("offers the seller's proposed resolutions, with the refund in paise", async () => {
    await deliver(sellerMessage("on_issue_resolution_proposed", issueId)).expect(200);
    const c = await complaint();
    const options = c.resolutions.map((r) => ({ type: r.type, amountPaise: r.amountPaise })).sort((a, b) => a.type.localeCompare(b.type));
    expect(options).toEqual([
      { type: "REFUND", amountPaise: 20000 },
      { type: "REPLACEMENT", amountPaise: null },
    ]);
  });

  it("tells the seller when the customer accepts one, pointing at the seller's own resolution id", async () => {
    const c = await complaint();
    const replacement = c.resolutions.find((r) => r.type === "REPLACEMENT")!;
    const before = sent.length;
    expect(await adapter.sendAction(complaintId, { code: "RESOLUTION_ACCEPTED", shortDesc: "Resolution accepted", resolutionRowId: replacement.id })).toEqual({
      sent: true,
    });
    expect(sent).toHaveLength(before + 1);
    const issue = sent.at(-1)!.envelope.message.issue;
    const last = (issue.actions as Record<string, unknown>[]).at(-1)!;
    expect(last).toMatchObject({ ref_id: "R2", ref_type: "RESOLUTIONS", descriptor: { code: "RESOLUTION_ACCEPTED" } });
    expect(issue.resolutions).toEqual(pramaan.on_issue_resolution_proposed!.message.issue.resolutions);
  });

  it("marks the complaint resolved when the seller says it is", async () => {
    await deliver(sellerMessage("on_issue_resolved", issueId)).expect(200);
    const c = await complaint();
    expect(c.status).toBe("RESOLVED");
    expect(c.resolvedAt).not.toBeNull();
  });

  it("applies a repeated on_issue once", async () => {
    const before = (await complaint()).actions.length;
    const body = sellerMessage("on_issue_resolved", issueId);
    await deliver(body).expect(200);
    await deliver(body).expect(200);
    expect((await complaint()).actions.length).toBe(before);
  });

  it("ignores another seller app answering an issue that was not sent to it", async () => {
    const before = await complaint();
    // New actions and a new resolution, so nothing here is a repeat that
    // deduplication alone would drop.
    const m = JSON.parse(sellerMessage("on_issue_resolution_proposed", issueId, "intruder.test"));
    m.message.issue.actions.push(
      { id: "X1", action_by: "NP2", updated_at: new Date().toISOString(), descriptor: { code: "INFO_REQUESTED", short_desc: "Send us your bank PIN" } },
    );
    m.message.issue.resolutions.push({ id: "X-R", descriptor: { code: "REFUND", short_desc: "Big refund" }, tags: [{ descriptor: { code: "RESOLUTION_DETAILS" }, list: [{ descriptor: { code: "REFUND_AMOUNT" }, value: "99999" }] }] });
    await deliver(JSON.stringify(m), "intruder.test", intruderKey).expect(200);
    const after = await complaint();
    expect(after.actions.length).toBe(before.actions.length);
    expect(after.resolutions.length).toBe(before.resolutions.length);
    expect(after.infoRequest).toBe(before.infoRequest);
    expect(after.status).toBe(before.status);
  });

  it("keeps a second complaint's actions apart when the seller reuses the same action ids", async () => {
    // Sellers number actions and resolutions per issue (A1, A2, R1), so two
    // complaints to the same seller carry the same ids.
    const order = await prisma.order.findFirstOrThrow({ where: { id: (await complaint()).orderId! } });
    const res = await agent
      .post("/api/complaints")
      .send({ orderId: order.id, category: "ORDER", subCategory: "ITEM_DAMAGED", description: "The box was crushed" })
      .expect(201);
    const secondId = res.body.complaint.id as string;
    expect((await adapter.sendIssue(secondId)).sent).toBe(true);
    const second = await prisma.complaint.findUniqueOrThrow({ where: { id: secondId } });
    await deliver(sellerMessage("on_issue_resolution_proposed", second.ondcIssueId!)).expect(200);
    const after = await prisma.complaint.findUniqueOrThrow({ where: { id: secondId }, include: { actions: true, resolutions: true } });
    expect(after.actions.some((a) => a.code === "RESOLUTION_PROPOSED")).toBe(true);
    expect(after.resolutions).toHaveLength(2);
  });

  it("holds back, and says why, a complaint about an order not placed over ONDC", async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { id: (await complaint()).orderId! } });
    const plain = await prisma.order.create({ data: { ...order, id: undefined, details: "{}", createdAt: undefined } });
    const res = await agent
      .post("/api/complaints")
      .send({ orderId: plain.id, category: "ORDER", subCategory: "WRONG_ITEM_DELIVERED", description: "Wrong dish in the bag" })
      .expect(201);
    const before = sent.length;
    const outcome = await adapter.sendIssue(res.body.complaint.id);
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toMatch(/not placed over ONDC/);
    expect(sent).toHaveLength(before);
    const held = await prisma.complaintMessage.findFirstOrThrow({ where: { complaintId: res.body.complaint.id, error: { contains: "not placed over ONDC" } } });
    expect(held.status).toBe("pending");
  });

  it("holds back a complaint whose reason has no ONDC category", async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { id: (await complaint()).orderId! } });
    const res = await agent
      .post("/api/complaints")
      .send({ orderId: order.id, category: "ORDER", subCategory: "OTHER", description: "something else" })
      .expect(201);
    const outcome = await adapter.sendIssue(res.body.complaint.id);
    expect(outcome).toMatchObject({ sent: false });
    expect(outcome.reason).toMatch(/no ONDC issue category/);
  });
});

describe("ONDC complaints switched on", () => {
  it("loads without tripping over the import cycle between the adapter and the service", async () => {
    const { vi } = await import("vitest");
    const was = process.env.ONDC_IGM_ENABLED;
    process.env.ONDC_IGM_ENABLED = "true";
    try {
      vi.resetModules();
      // The order that broke: the network module first, which pulls in the
      // service, which pulls in the adapter while the network class is not
      // yet defined.
      await import("../src/modules/complaints/igm.network.js");
      const { igmAdapter } = await import("../src/modules/complaints/igm.adapter.js");
      expect(igmAdapter.live).toBe(true);
      expect(typeof igmAdapter.sendAction).toBe("function");
    } finally {
      if (was === undefined) delete process.env.ONDC_IGM_ENABLED;
      else process.env.ONDC_IGM_ENABLED = was;
      vi.resetModules();
    }
  });
});
