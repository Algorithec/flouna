import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A shared ride never takes more riders than the vehicle has seats.
//
// Joining counted the members and then added one. Two friends joining for the
// last seat at the same moment both saw a free seat and both got in, which
// puts four people in a three seat auto and splits the fare four ways.

const RIDE = {
  provider: "ondc" as const,
  productName: "ONDC Auto", // 3 seats
  pickup: "Hitech City",
  drop: "Airport",
  pickupLat: 17.4401,
  pickupLng: 78.3489,
  dropLat: 17.2403,
  dropLng: 78.4294,
};

describe("joining a shared ride for the last seat", () => {
  it("lets only one of two simultaneous riders in", async () => {
    const host = await authedAgent({ withAddress: false });
    const created = await host.agent.post("/api/groups").send({ domain: "ride", ride: RIDE }).expect(201);
    const { id, code } = created.body;
    await (await authedAgent({ withAddress: false })).agent.post("/api/groups/join").send({ code }).expect(200);

    // One seat left, two people reach for it.
    const [a, b] = await Promise.all([authedAgent({ withAddress: false }), authedAgent({ withAddress: false })]);
    const results = await Promise.all([
      a.agent.post("/api/groups/join").send({ code }),
      b.agent.post("/api/groups/join").send({ code }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.groupCartMember.count({ where: { cartId: id } })).toBe(3);
  });
});
