import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// Group ride-sharing: one shared trip, fare recomputed server-side, split
// equally among everyone who joined, host books one trackable ride order.

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

async function createRideGroup(agent: Awaited<ReturnType<typeof authedAgent>>["agent"]) {
  return agent.post("/api/groups").send({ domain: "ride", ride: RIDE });
}

describe("group ride-sharing", () => {
  it("creates a shared ride with a server-computed fare snapshot", async () => {
    const host = await authedAgent();
    const res = await createRideGroup(host.agent);
    expect(res.status).toBe(201);
    expect(res.body.domain).toBe("ride");
    expect(res.body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(res.body.ride.displayName).toBe("Cab Saver");
    expect(res.body.ride.seats).toBe(4);
    expect(res.body.totalPaise).toBeGreaterThan(0);
    // Host alone → owes the whole fare so far.
    expect(res.body.equalSplitPaise).toBe(res.body.totalPaise);
    expect(res.body.members).toHaveLength(1);
  });

  it("rejects sharing a bike (single seat)", async () => {
    const host = await authedAgent();
    const res = await host.agent
      .post("/api/groups")
      .send({ domain: "ride", ride: { ...RIDE, productName: "ONDC Bike" } });
    // ONDC has no bike product; use a provider that does.
    const res2 = await host.agent
      .post("/api/groups")
      .send({
        domain: "ride",
        ride: { ...RIDE, provider: "rapido", productName: "Rapido Bike" },
      });
    expect([400, 404]).toContain(res.status);
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/autos and cabs/i);
  });

  it("splits the fare equally as members join", async () => {
    const host = await authedAgent();
    const created = await createRideGroup(host.agent);
    const { id, code, totalPaise } = created.body;

    const friend1 = await authedAgent();
    const friend2 = await authedAgent();
    await friend1.agent.post("/api/groups/join").send({ code }).expect(200);
    const view = await friend2.agent.post("/api/groups/join").send({ code }).expect(200);

    expect(view.body.members).toHaveLength(3);
    expect(view.body.equalSplitPaise).toBe(Math.round(totalPaise / 3));
    // Everyone sees the same trip.
    expect(view.body.ride.drop).toBe("Airport");
    // Non-members still can't read the cart.
    const stranger = await authedAgent();
    await stranger.agent.get(`/api/groups/${id}`).expect(403);
  });

  it("caps members at the vehicle's seats", async () => {
    const host = await authedAgent();
    const created = await host.agent.post("/api/groups").send({
      domain: "ride",
      ride: { ...RIDE, productName: "ONDC Auto" }, // 3 seats
    });
    const { code } = created.body;
    await (await authedAgent()).agent.post("/api/groups/join").send({ code }).expect(200);
    await (await authedAgent()).agent.post("/api/groups/join").send({ code }).expect(200);
    // 4th person → the auto is full.
    const overflow = await (await authedAgent()).agent
      .post("/api/groups/join")
      .send({ code });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error).toMatch(/full/i);
  });

  it("rejects adding dishes to a shared ride", async () => {
    const host = await authedAgent();
    const created = await createRideGroup(host.agent);
    const res = await host.agent
      .post(`/api/groups/${created.body.id}/items`)
      .send({ dishId: "dum-biryani", qty: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/shared ride/i);
  });

  it("host checkout books one trackable ride order with equal shares + UPI links", async () => {
    const host = await authedAgent();
    const created = await createRideGroup(host.agent);
    const { id, code } = created.body;
    const friend = await authedAgent();
    await friend.agent.post("/api/groups/join").send({ code }).expect(200);

    // Friend can't book.
    await friend.agent.post(`/api/groups/${id}/checkout`).send({}).expect(403);

    const checkout = await host.agent
      .post(`/api/groups/${id}/checkout`)
      .send({ hostUpiId: "host@upi" })
      .expect(200);
    expect(checkout.body.shares).toHaveLength(2);
    const friendShare = checkout.body.shares.find((s: { isHost: boolean }) => !s.isHost);
    expect(friendShare.sharePaise).toBe(Math.round(checkout.body.totalPaise / 2));
    expect(friendShare.upiLink).toContain("upi://pay?");
    expect(friendShare.upiLink).toContain("host%40upi");

    // The order is a real ride order: pay it and tracking works.
    const orderId = checkout.body.orderId as string;
    await host.agent.post("/api/payments/checkout").send({ orderId }).expect(200);
    await host.agent
      .post("/api/payments/simulate")
      .send({ orderId, method: "upi" })
      .expect(200);
    const track = await host.agent.get(`/api/orders/${orderId}/track`).expect(200);
    expect(["searching", "arriving", "arrived", "in_progress"]).toContain(
      track.body.tracking.state,
    );

    const order = await host.agent.get(`/api/orders/${orderId}`).expect(200);
    expect(order.body.order.domain).toBe("ride");
    expect(order.body.order.details.group).toBe(true);
    expect(order.body.order.details.memberCount).toBe(2);
    expect(order.body.order.title).toContain("2 riders");

    // Second checkout → already ordered.
    await host.agent.post(`/api/groups/${id}/checkout`).send({}).expect(409);
  });

  it("food group carts still work exactly as before (regression)", async () => {
    const host = await authedAgent();
    const cart = await host.agent
      .post("/api/groups")
      .send({ platform: "ondc" })
      .expect(201);
    expect(cart.body.domain).toBe("food");
    expect(cart.body.ride).toBeNull();
    await host.agent
      .post(`/api/groups/${cart.body.id}/items`)
      .send({ dishId: "dum-biryani", qty: 1 })
      .expect(201);
  });
});
