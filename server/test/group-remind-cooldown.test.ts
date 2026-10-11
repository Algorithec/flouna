import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// The nudge sends a push notification to every member who has not ordered yet.
// WHO it reaches was bounded; how often each of them heard about it was not,
// and the comment on the route claimed otherwise. A host tapping it in a loop
// therefore owned the lock screen of anybody still reading the menu, and a
// member has no way to order themselves out of a cart they did not want to
// join.
//
// Also checks that removing an item is refused once the host has paid: the
// cart is the settle-up record by then, and a member who deleted their own
// lines after checkout showed as owing nothing for food already bought.

async function cartWithAWaitingMember() {
  const host = await authedAgent();
  const friend = await authedAgent();
  const created = await host.agent
    .post("/api/groups")
    .send({ platform: "ondc" })
    .expect(201);
  await friend.agent
    .post("/api/groups/join")
    .send({ code: created.body.code })
    .expect(200);
  return { host, friend, cartId: created.body.id as string };
}

describe("nudging the people who have not ordered", () => {
  it("notifies a waiting member once, however many times the host taps", async () => {
    const { host, cartId } = await cartWithAWaitingMember();

    const first = await host.agent.post(`/api/groups/${cartId}/remind`).send({}).expect(200);
    expect(first.body.reminded).toBe(1);

    // Tapped again, and again. The member is still waiting, so they are still
    // eligible — and must not be told four more times.
    for (let i = 0; i < 3; i++) {
      const again = await host.agent.post(`/api/groups/${cartId}/remind`).send({}).expect(200);
      expect(again.body.reminded).toBe(0);
      // Still honest about who is being waited on.
      expect(again.body.waiting).toBe(1);
    }
  });

  it("does not hold one group's cooldown against another", async () => {
    const a = await cartWithAWaitingMember();
    const b = await cartWithAWaitingMember();
    const first = await a.host.agent.post(`/api/groups/${a.cartId}/remind`).send({}).expect(200);
    const second = await b.host.agent.post(`/api/groups/${b.cartId}/remind`).send({}).expect(200);
    expect(first.body.reminded).toBe(1);
    expect(second.body.reminded).toBe(1);
  });
});

describe("a placed group order is a settled record", () => {
  it("refuses to remove an item after the host has checked out", async () => {
    const { host, friend, cartId } = await cartWithAWaitingMember();
    const added = await friend.agent
      .post(`/api/groups/${cartId}/items`)
      .send({ dishId: "masala-dosa" })
      .expect(201);
    const mine = added.body.items.find(
      (i: { isYou: boolean }) => i.isYou,
    ) as { id: string };

    await host.agent.post(`/api/groups/${cartId}/checkout`).send({}).expect(200);

    const res = await friend.agent.delete(`/api/groups/${cartId}/items/${mine.id}`);
    expect(res.status).toBe(409);

    // And the share is still on the host's screen.
    const cart = await host.agent.get(`/api/groups/${cartId}`).expect(200);
    expect(cart.body.totalPaise).toBeGreaterThan(0);
  });

  it("still lets a member remove their own item while the cart is open", async () => {
    const { friend, cartId } = await cartWithAWaitingMember();
    const added = await friend.agent
      .post(`/api/groups/${cartId}/items`)
      .send({ dishId: "masala-dosa" })
      .expect(201);
    const mine = added.body.items.find((i: { isYou: boolean }) => i.isYou) as {
      id: string;
    };
    const after = await friend.agent
      .delete(`/api/groups/${cartId}/items/${mine.id}`)
      .expect(200);
    expect(after.body.items).toHaveLength(0);
  });
});
