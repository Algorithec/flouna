import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { splitFare, rupeesExact } from "../src/modules/groups/split.js";

// The shares of a shared ride have to add up to the fare.
//
// Each share was round(fare / riders), the same for everyone, so ₹100
// between three was ₹33.33 each and ₹99.99 in total: the host, who paid the
// whole fare, was short on every such trip. The notification also rounded the
// share to whole rupees while the UPI link asked for paise, so a friend was
// told one number and asked for another.

describe("dividing a fare", () => {
  it.each([
    [10000, 3],
    [10000, 4],
    [17900, 3],
    [12345, 4],
    [100, 3],
    [5000, 1],
  ])("splits %i paise between %i people with nothing lost", (total, people) => {
    const { hostPaise, otherPaise } = splitFare(total, people);
    expect(hostPaise + otherPaise * (people - 1)).toBe(total);
    // Every friend pays the same, and the host never more than a few paise extra.
    expect(hostPaise - otherPaise).toBeGreaterThanOrEqual(0);
    expect(hostPaise - otherPaise).toBeLessThan(people);
  });

  it("states a share exactly, in rupees", () => {
    expect(rupeesExact(3333)).toBe("₹33.33");
    expect(rupeesExact(3300)).toBe("₹33");
  });
});

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

describe("a shared ride's shares", () => {
  async function rideOf(riders: number) {
    const host = await authedAgent({ withAddress: false });
    const created = await host.agent.post("/api/groups").send({ domain: "ride", ride: RIDE }).expect(201);
    for (let i = 1; i < riders; i++) {
      const friend = await authedAgent({ withAddress: false });
      await friend.agent.post("/api/groups/join").send({ code: created.body.code }).expect(200);
    }
    return { host, id: created.body.id as string };
  }

  it.each([2, 3, 4])("add up to the fare at checkout with %i riders", async (riders) => {
    const { host, id } = await rideOf(riders);
    const res = await host.agent
      .post(`/api/groups/${id}/checkout`)
      .send({ hostUpiId: "host@upi" })
      .expect(200);

    const shares = res.body.shares as { sharePaise: number; isHost: boolean; upiLink: string | null }[];
    expect(shares).toHaveLength(riders);
    expect(shares.reduce((s, x) => s + x.sharePaise, 0)).toBe(res.body.totalPaise);

    // Each friend's payment link asks for exactly their share.
    for (const s of shares.filter((x) => !x.isHost)) {
      const am = new URL(s.upiLink!.replace("upi://", "https://upi.local/")).searchParams.get("am");
      expect(Math.round(Number(am) * 100)).toBe(s.sharePaise);
    }
  });

  it("add up to the fare on the screen before anyone pays", async () => {
    const { host, id } = await rideOf(3);
    const view = await host.agent.get(`/api/groups/${id}`).expect(200);
    const lines = view.body.members as { subtotalPaise: number }[];
    expect(lines.reduce((s, m) => s + m.subtotalPaise, 0)).toBe(view.body.totalPaise);
  });
});
