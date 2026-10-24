import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { authedAgent } from "./helpers.js";

// A customer's ONDC food orders and rides in their history, and the summary
// the help screen shows for one.

async function customer() {
  const signedUp = await authedAgent();
  const user = await prisma.user.findUniqueOrThrow({ where: { email: signedUp.email } });
  return { ...signedUp, userId: user.id };
}

const food = (userId: string, status: string, at: Date) =>
  prisma.ondcOrder.create({
    data: {
      userId,
      txnId: crypto.randomUUID(),
      status,
      bppId: "s",
      bppUri: "https://s",
      providerId: "p",
      locationId: "l",
      storeName: `Store ${status}`,
      city: "std:080",
      lines: JSON.stringify([{ itemId: "I1", count: 1 }, { itemId: "I2", count: 2 }]),
      totalPaise: 47500,
      createdAt: at,
    },
  });

const ride = (userId: string, status: string, at: Date) =>
  prisma.ondcRide.create({
    data: { userId, txnId: crypto.randomUUID(), status, city: "std:080", pickup: "{}", drop: JSON.stringify({ address: "Charminar, Hyderabad" }), farePaise: 14600, createdAt: at },
  });

describe("a customer's ONDC orders and rides", () => {
  it("lists the ones that got somewhere, newest first, and none of anyone else's", async () => {
    const c = await customer();
    await food(c.userId, "placed", new Date("2026-10-20T10:00:00Z"));
    await food(c.userId, "quoted", new Date("2026-10-21T10:00:00Z")); // a price check that went nowhere
    await ride(c.userId, "completed", new Date("2026-10-21T12:00:00Z"));
    await ride(c.userId, "searching", new Date("2026-10-21T13:00:00Z"));
    const other = await customer();
    await food(other.userId, "placed", new Date("2026-10-21T14:00:00Z"));

    const { entries } = (await c.agent.get("/api/ondc/mine").expect(200)).body as { entries: { kind: string; title: string; href: string }[] };
    expect(entries.map((e) => [e.kind, e.title])).toEqual([
      ["ride", "Charminar, Hyderabad"],
      ["food", "Store placed"],
    ]);
    expect(entries[0]!.href).toMatch(/^\/rides\/ondc\//);
    expect(entries[1]!.href).toMatch(/^\/food\/ondc\//);
  });

  it("shows a food order the seller reports delivered as completed", async () => {
    const c = await customer();
    const o = await food(c.userId, "placed", new Date());
    await prisma.ondcOrder.update({ where: { id: o.id }, data: { sellerState: "Completed" } });
    const { entries } = (await c.agent.get("/api/ondc/mine").expect(200)).body as { entries: { status: string }[] };
    expect(entries[0]!.status).toBe("completed");
  });

  it("stays readable with ONDC switched off, so an order made while it was on can still be found", async () => {
    expect(env.ONDC_SEARCH_ENABLED).toBe(false);
    const c = await customer();
    const o = await food(c.userId, "placed", new Date());
    await c.agent.get("/api/ondc/mine").expect(200);
    expect((await c.agent.get(`/api/ondc/mine/${o.id}`).expect(200)).body).toMatchObject({ kind: "food", title: "Store placed", itemCount: 2 });
  });

  it("describes one order to its owner only", async () => {
    const c = await customer();
    const r = await ride(c.userId, "completed", new Date());
    expect((await c.agent.get(`/api/ondc/mine/${r.id}`).expect(200)).body).toMatchObject({ kind: "ride", title: "Charminar, Hyderabad" });
    const stranger = await customer();
    await stranger.agent.get(`/api/ondc/mine/${r.id}`).expect(404);
  });
});

// From the review on #86: one row that does not parse used to fail the whole
// list with a 500, and the list could hold fifty orders and fifty rides.
describe("the ONDC history, past a bad row and at its length", () => {
  it("stays readable past a row whose stored details do not parse", async () => {
    const c = await customer();
    const badRide = await ride(c.userId, "booked", new Date());
    await prisma.ondcRide.update({ where: { id: badRide.id }, data: { drop: "not json" } });
    const badFood = await food(c.userId, "placed", new Date());
    await prisma.ondcOrder.update({ where: { id: badFood.id }, data: { lines: "not json" } });
    const list = await c.agent.get("/api/ondc/mine").expect(200);
    expect(list.body.entries.find((e: { id: string }) => e.id === badRide.id)).toMatchObject({ title: "" });
    expect((await c.agent.get(`/api/ondc/mine/${badRide.id}`).expect(200)).body).toMatchObject({ kind: "ride", title: "" });
    expect((await c.agent.get(`/api/ondc/mine/${badFood.id}`).expect(200)).body).toMatchObject({ kind: "food", itemCount: null });
  });

  it("shows fifty in all, newest first, not fifty of each", async () => {
    const c = await customer();
    const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, i));
    const base = { userId: c.userId, bppId: "s", bppUri: "https://s", providerId: "p", locationId: "l", storeName: "Store", city: "std:080", lines: "[]", status: "placed" };
    await prisma.ondcOrder.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ ...base, txnId: crypto.randomUUID(), createdAt: at(2 * i) })) });
    await prisma.ondcRide.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({ userId: c.userId, txnId: crypto.randomUUID(), status: "completed", city: "std:080", pickup: "{}", drop: "{}", createdAt: at(2 * i + 1) })),
    });
    const entries = (await c.agent.get("/api/ondc/mine").expect(200)).body.entries as { createdAt: string }[];
    expect(entries).toHaveLength(50);
    expect(entries[0]!.createdAt).toBe(at(59).toISOString());
    expect(entries.every((e, i) => i === 0 || entries[i - 1]!.createdAt >= e.createdAt)).toBe(true);
  });
});
