import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Saved payment methods (Profile → Payment Methods).
//
// This is deliberately NOT a card vault: a real charge goes through Cashfree's
// hosted checkout, and this list only holds what's needed to recognise a
// method. The tests below are written to hold that line — the schema must have
// nowhere to put a full card number or a CVV — as well as the ordinary
// ownership and validation rules.

const CARD = {
  type: "card",
  label: "Visa",
  last4: "4242",
  expiryMonth: 12,
  expiryYear: new Date().getFullYear() + 3,
};
const UPI = { type: "upi", label: "UPI ID", vpa: "someone@okicici" };

describe("payment methods", () => {
  it("saves a card, lists it, and never stores more than the last four", async () => {
    const { agent } = await authedAgent();
    const created = await agent.post("/api/users/payment-methods").send(CARD).expect(201);
    expect(created.body.method.last4).toBe("4242");
    expect(created.body.method.label).toBe("Visa");

    const list = await agent.get("/api/users/payment-methods").expect(200);
    expect(list.body.methods).toHaveLength(1);

    // The stored row must carry no field capable of holding a PAN or CVV.
    const row = await prisma.paymentMethod.findFirstOrThrow({
      where: { id: created.body.method.id },
    });
    const keys = Object.keys(row).join(",").toLowerCase();
    expect(keys).not.toContain("cvv");
    expect(keys).not.toContain("cardnumber");
    expect(keys).not.toContain("pan");
    expect(JSON.stringify(row)).not.toContain("4242424242424242");
  });

  it("drops a smuggled card number or CVV instead of storing it", async () => {
    const { agent } = await authedAgent();
    const res = await agent
      .post("/api/users/payment-methods")
      .send({ ...CARD, cardNumber: "4242424242424242", cvv: "123" })
      .expect(201);
    const row = await prisma.paymentMethod.findFirstOrThrow({
      where: { id: res.body.method.id },
    });
    expect(JSON.stringify(row)).not.toContain("4242424242424242");
    expect(row).not.toHaveProperty("cvv");
    const vals = Object.values(row).map(String).join("|");
    expect(vals).not.toMatch(/\b123\b/);
  });

  it("saves a UPI id and rejects a malformed one", async () => {
    const { agent } = await authedAgent();
    const ok = await agent.post("/api/users/payment-methods").send(UPI).expect(201);
    expect(ok.body.method.vpa).toBe("someone@okicici");

    for (const vpa of ["nope", "@bank", "someone@", "a@b c"]) {
      await agent
        .post("/api/users/payment-methods")
        .send({ ...UPI, vpa })
        .expect(400);
    }
  });

  it("requires the card fields on a card and refuses an unknown brand", async () => {
    const { agent } = await authedAgent();
    await agent
      .post("/api/users/payment-methods")
      .send({ type: "card", label: "Visa" })
      .expect(400);
    await agent
      .post("/api/users/payment-methods")
      .send({ ...CARD, label: "Discover" })
      .expect(400);
    await agent
      .post("/api/users/payment-methods")
      .send({ ...CARD, last4: "42" })
      .expect(400);
  });

  it("refuses an already-expired card year", async () => {
    const { agent } = await authedAgent();
    await agent
      .post("/api/users/payment-methods")
      .send({ ...CARD, expiryYear: new Date().getFullYear() - 1 })
      .expect(400);
  });

  it("keeps exactly one default as it moves between methods", async () => {
    const { agent } = await authedAgent();
    const a = await agent
      .post("/api/users/payment-methods")
      .send({ ...CARD, isDefault: true })
      .expect(201);
    const b = await agent
      .post("/api/users/payment-methods")
      .send({ ...UPI, isDefault: true })
      .expect(201);

    // Creating a second default demotes the first.
    let list = await agent.get("/api/users/payment-methods").expect(200);
    expect(list.body.methods.filter((m: { isDefault: boolean }) => m.isDefault)).toHaveLength(1);
    expect(list.body.methods[0].id).toBe(b.body.method.id);

    // And moving it back demotes the other.
    await agent.patch(`/api/users/payment-methods/${a.body.method.id}/default`).expect(200);
    list = await agent.get("/api/users/payment-methods").expect(200);
    const defaults = list.body.methods.filter((m: { isDefault: boolean }) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(a.body.method.id);
  });

  it("refuses a duplicate, so the list never shows two identical rows", async () => {
    const { agent } = await authedAgent();
    await agent.post("/api/users/payment-methods").send(CARD).expect(201);
    await agent.post("/api/users/payment-methods").send(CARD).expect(409);
    await agent.post("/api/users/payment-methods").send(UPI).expect(201);
    await agent.post("/api/users/payment-methods").send(UPI).expect(409);

    expect((await agent.get("/api/users/payment-methods").expect(200)).body.methods)
      .toHaveLength(2);

    // A genuinely different card still goes in.
    await agent
      .post("/api/users/payment-methods")
      .send({ ...CARD, last4: "1881" })
      .expect(201);
    expect((await agent.get("/api/users/payment-methods").expect(200)).body.methods)
      .toHaveLength(3);
  });

  it("one account's method does not block another account adding the same one", async () => {
    const a = await authedAgent();
    const b = await authedAgent();
    await a.agent.post("/api/users/payment-methods").send(UPI).expect(201);
    // Two people can legitimately share a UPI id (a household account).
    await b.agent.post("/api/users/payment-methods").send(UPI).expect(201);
  });

  it("deletes only the caller's own method", async () => {
    const { agent } = await authedAgent();
    const created = await agent.post("/api/users/payment-methods").send(CARD).expect(201);
    await agent.delete(`/api/users/payment-methods/${created.body.method.id}`).expect(204);
    expect((await agent.get("/api/users/payment-methods").expect(200)).body.methods)
      .toHaveLength(0);
  });
});

describe("payment methods belong to one account only", () => {
  it("another account can neither see, re-default, nor delete them", async () => {
    const owner = await authedAgent();
    const attacker = await authedAgent();
    const created = await owner.agent
      .post("/api/users/payment-methods")
      .send(CARD)
      .expect(201);
    const id = created.body.method.id as string;

    expect((await attacker.agent.get("/api/users/payment-methods").expect(200)).body.methods)
      .toHaveLength(0);
    await attacker.agent.patch(`/api/users/payment-methods/${id}/default`).expect(404);
    await attacker.agent.delete(`/api/users/payment-methods/${id}`).expect(404);

    // Still there, still the owner's.
    const still = await prisma.paymentMethod.findUnique({ where: { id } });
    expect(still).not.toBeNull();
  });

  it("setting a default cannot reach across accounts", async () => {
    const a = await authedAgent();
    const b = await authedAgent();
    const aCard = await a.agent
      .post("/api/users/payment-methods")
      .send({ ...CARD, isDefault: true })
      .expect(201);
    const bCard = await b.agent
      .post("/api/users/payment-methods")
      .send({ ...UPI, isDefault: true })
      .expect(201);

    // B re-defaults their own; A's default must be untouched.
    await b.agent.patch(`/api/users/payment-methods/${bCard.body.method.id}/default`).expect(200);
    const aStill = await prisma.paymentMethod.findUniqueOrThrow({
      where: { id: aCard.body.method.id },
    });
    expect(aStill.isDefault).toBe(true);
  });

  it("requires a session", async () => {
    await request(app).get("/api/users/payment-methods").expect(401);
    await request(app).post("/api/users/payment-methods").send(CARD).expect(401);
    await request(app).delete("/api/users/payment-methods/whatever").expect(401);
  });
});
