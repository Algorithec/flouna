import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A group is checked out once, however many times the host taps.
//
// Checkout read the group as open, created the order, then marked the group
// ordered. Two taps at the same moment both read it as open and both created
// an order, so the group's food or ride was ordered, and payable, twice.

const RIDE = {
  provider: "ondc" as const,
  productName: "ONDC Cab",
  pickup: "Hitech City",
  drop: "Airport",
  pickupLat: 17.4401,
  pickupLng: 78.3489,
  dropLat: 17.2403,
  dropLng: 78.4294,
};

async function hostOrders(email: string) {
  const me = await prisma.user.findUniqueOrThrow({ where: { email } });
  return prisma.order.count({ where: { userId: me.id } });
}

describe("checking out a group twice at once", () => {
  it("creates one ride order", async () => {
    const host = await authedAgent({ withAddress: false });
    const created = await host.agent.post("/api/groups").send({ domain: "ride", ride: RIDE }).expect(201);
    const id = created.body.id as string;

    const results = await Promise.all([
      host.agent.post(`/api/groups/${id}/checkout`).send({}),
      host.agent.post(`/api/groups/${id}/checkout`).send({}),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.find((r) => r.status !== 200)?.status).toBe(409);
    expect(await hostOrders(host.email)).toBe(1);
  });

  it("creates one food order", async () => {
    const host = await authedAgent();
    const created = await host.agent.post("/api/groups").send({ platform: "ondc" }).expect(201);
    const id = created.body.id as string;
    await host.agent.post(`/api/groups/${id}/items`).send({ dishId: "masala-dosa", qty: 1 }).expect(201);

    const results = await Promise.all([
      host.agent.post(`/api/groups/${id}/checkout`).send({}),
      host.agent.post(`/api/groups/${id}/checkout`).send({}),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await hostOrders(host.email)).toBe(1);
  });
});
