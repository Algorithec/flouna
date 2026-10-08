import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A shared ride is charged the total its members were shown, or not at all.
//
// The fare is priced when the group is set up, and that is the total every
// member sees and splits. The host checks out later, possibly hours later, and
// the server re-prices the trip then. When the two differed, the group was
// charged a total none of them had seen, split in shares nobody agreed to.

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

async function groupWithFriend() {
  const host = await authedAgent({ withAddress: false });
  const created = await host.agent.post("/api/groups").send({ domain: "ride", ride: RIDE }).expect(201);
  const friend = await authedAgent({ withAddress: false });
  await friend.agent.post("/api/groups/join").send({ code: created.body.code }).expect(200);
  return { host, friend, id: created.body.id as string, shownTotal: created.body.totalPaise as number };
}

/** The fare the group was shown, as if priced earlier at a different moment. */
async function setShownFare(id: string, farePaise: number) {
  const cart = await prisma.groupCart.findUniqueOrThrow({ where: { id } });
  const ride = JSON.parse(cart.rideDetails ?? "{}");
  await prisma.groupCart.update({
    where: { id },
    data: { rideDetails: JSON.stringify({ ...ride, farePaise }) },
  });
}

describe("checking out a shared ride whose fare has moved", () => {
  it("refuses to charge a total the members never saw", async () => {
    const { host, id, shownTotal } = await groupWithFriend();
    await setShownFare(id, shownTotal - 5000);

    const res = await host.agent.post(`/api/groups/${id}/checkout`).send({}).expect(409);
    expect(res.body.error).toMatch(/fare has changed/i);
    const me = await prisma.user.findUniqueOrThrow({ where: { email: host.email } });
    expect(await prisma.order.count({ where: { userId: me.id } })).toBe(0);
  });

  it("shows everyone the new fare, then books it", async () => {
    const { host, friend, id, shownTotal } = await groupWithFriend();
    await setShownFare(id, shownTotal - 5000);
    await host.agent.post(`/api/groups/${id}/checkout`).send({}).expect(409);

    // Every member now sees the real total and their share of it.
    const seen = await friend.agent.get(`/api/groups/${id}`).expect(200);
    expect(seen.body.totalPaise).toBe(shownTotal);

    const booked = await host.agent.post(`/api/groups/${id}/checkout`).send({}).expect(200);
    expect(booked.body.totalPaise).toBe(shownTotal);
  });

  it("books straight away when nothing has moved", async () => {
    const { host, id, shownTotal } = await groupWithFriend();
    const booked = await host.agent.post(`/api/groups/${id}/checkout`).send({}).expect(200);
    expect(booked.body.totalPaise).toBe(shownTotal);
  });
});
