import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A member who sets their profile to "nobody" is told their name is hidden
// inside group orders. The cart screen honoured that; three other surfaces in
// the same cart read the name straight off the User row and printed it.
//
// Written as the attack: join a cart, hide, then look for the real name
// everywhere the cart will show a person.

const KEY = Buffer.from("k".repeat(64)).toString("base64");
const SIG = Buffer.from("s".repeat(64)).toString("base64");
const IV = Buffer.from("0123456789ab").toString("base64");
const CIPHER = Buffer.from("ciphertext-bytes").toString("base64");

async function hiddenCart() {
  const host = await authedAgent();
  const friend = await authedAgent();
  // A distinctive name, so a leak cannot be mistaken for anything else.
  await prisma.user.update({
    where: { email: friend.email },
    data: { name: "Priya Sharma", profileVisibility: "nobody" },
  });
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

describe("a hidden member stays hidden across the whole cart", () => {
  it("does not name them in the cart summary (the surface that already worked)", async () => {
    const { host, cartId } = await hiddenCart();
    const cart = await host.agent.get(`/api/groups/${cartId}`).expect(200);
    expect(JSON.stringify(cart.body)).not.toContain("Priya Sharma");
  });

  it("does not name them in the encrypted chat's device list", async () => {
    const { host, friend, cartId } = await hiddenCart();
    await friend.agent
      .post(`/api/groups/${cartId}/chat/devices`)
      .send({ deviceId: "friend-device-0001", publicKey: KEY, signingKey: SIG })
      .expect(201);
    await host.agent
      .post(`/api/groups/${cartId}/chat/devices`)
      .send({ deviceId: "host-device-00001", publicKey: KEY, signingKey: SIG })
      .expect(201);

    const keys = await host.agent
      .get(`/api/groups/${cartId}/chat/keys?deviceId=host-device-00001`)
      .expect(200);
    expect(keys.body.devices).toHaveLength(2);
    expect(JSON.stringify(keys.body.devices)).not.toContain("Priya Sharma");
  });

  it("does not name them on the messages they send", async () => {
    const { host, friend, cartId } = await hiddenCart();
    await friend.agent
      .post(`/api/groups/${cartId}/chat/devices`)
      .send({ deviceId: "friend-device-0001", publicKey: KEY, signingKey: SIG })
      .expect(201);
    await friend.agent
      .post(`/api/groups/${cartId}/chat/messages`)
      .send({
        senderDevice: "friend-device-0001",
        index: 0,
        iv: IV,
        ciphertext: CIPHER,
        signature: SIG,
      })
      .expect(201);

    const read = await host.agent
      .get(`/api/groups/${cartId}/chat/messages`)
      .expect(200);
    expect(read.body.messages).toHaveLength(1);
    expect(read.body.messages[0].senderName).not.toBe("Priya Sharma");
  });

  it("does not name them in the host's checkout shares or the UPI note", async () => {
    const { host, friend, cartId } = await hiddenCart();
    await friend.agent
      .post(`/api/groups/${cartId}/items`)
      .send({ dishId: "masala-dosa" })
      .expect(201);

    const out = await host.agent
      .post(`/api/groups/${cartId}/checkout`)
      .send({ hostUpiId: "host@okaxis" })
      .expect(200);
    expect(out.body.shares.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.body.shares)).not.toContain("Priya Sharma");

    // And not written into the order record either, where it would outlive the
    // setting entirely.
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: out.body.orderId },
      select: { details: true },
    });
    expect(order.details).not.toContain("Priya Sharma");
  });

  it("still shows a name when the member allows it", async () => {
    const host = await authedAgent();
    const friend = await authedAgent();
    await prisma.user.update({
      where: { email: friend.email },
      data: { name: "Open Member", profileVisibility: "everyone" },
    });
    const created = await host.agent
      .post("/api/groups")
      .send({ platform: "ondc" })
      .expect(201);
    await friend.agent
      .post("/api/groups/join")
      .send({ code: created.body.code })
      .expect(200);

    await friend.agent
      .post(`/api/groups/${created.body.id}/items`)
      .send({ dishId: "masala-dosa" })
      .expect(201);
    const out = await host.agent
      .post(`/api/groups/${created.body.id}/checkout`)
      .send({})
      .expect(200);
    expect(JSON.stringify(out.body.shares)).toContain("Open Member");
  });
});

describe("a hidden member stays hidden in a saved crew", () => {
  it("does not name them in the crew, its list, or last time's order", async () => {
    const { host, friend, cartId } = await hiddenCart();
    await friend.agent
      .post(`/api/groups/${cartId}/items`)
      .send({ dishId: "masala-dosa" })
      .expect(201);

    const saved = await host.agent
      .post("/api/groups/crews")
      .send({ cartId, name: "Friday lot" })
      .expect(201);
    expect(JSON.stringify(saved.body.crew)).not.toContain("Priya Sharma");

    const one = await host.agent
      .get(`/api/groups/crews/${saved.body.crew.id}`)
      .expect(200);
    expect(one.body.crew.members).toHaveLength(2);
    expect(JSON.stringify(one.body.crew)).not.toContain("Priya Sharma");

    const list = await host.agent.get("/api/groups/crews").expect(200);
    expect(JSON.stringify(list.body)).not.toContain("Priya Sharma");
  });
});
