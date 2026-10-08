import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// How many chat devices one account keeps.
//
// Every browser that signs in registers a device, and nothing ever retired
// one. An account used across a few browsers, cleared caches and private
// windows reached 161 devices, and a member of a group with that account owed
// a chain to all of them. The upload of those chains is limited to 60 at a
// time, so every attempt was refused and the member's messages could no longer
// be read by anyone who joined after. The safety number also covered 161
// devices nobody was using. An account now keeps its most recently seen
// devices, and the rest are retired.

const KEY = Buffer.from("k".repeat(64)).toString("base64");
const SIG = Buffer.from("s".repeat(64)).toString("base64");
const MAX = 10;

async function idOf(email: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
}

describe("an account's chat devices", () => {
  it("keeps only the most recently seen ones", async () => {
    const { agent, email } = await authedAgent();
    const userId = await idOf(email);
    // Twelve old devices, last seen a day apart.
    const day = 86_400_000;
    await prisma.chatDevice.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({
        userId,
        deviceId: `old-device-${String(i).padStart(4, "0")}`,
        publicKey: KEY,
        signingKey: SIG,
        lastSeenAt: new Date(Date.now() - (i + 1) * day),
      })),
    });

    await agent
      .post("/api/users/chat-device")
      .send({ deviceId: "new-device-0000", publicKey: KEY, signingKey: SIG })
      .expect(201);

    const kept = await prisma.chatDevice.findMany({ where: { userId }, orderBy: { lastSeenAt: "desc" } });
    expect(kept).toHaveLength(MAX);
    expect(kept[0]!.deviceId).toBe("new-device-0000");
    // The oldest are the ones retired.
    expect(kept.map((d) => d.deviceId)).not.toContain("old-device-0011");
    expect(kept.map((d) => d.deviceId)).toContain("old-device-0000");
  });

  it("drops what was waiting for a retired device", async () => {
    const { agent, email } = await authedAgent();
    const userId = await idOf(email);
    const cart = await agent.post("/api/groups").send({ platform: "ondc" }).expect(201);
    await prisma.chatDevice.createMany({
      data: Array.from({ length: MAX }, (_, i) => ({
        userId,
        deviceId: `aged-device-${String(i).padStart(4, "0")}`,
        publicKey: KEY,
        signingKey: SIG,
        lastSeenAt: new Date(Date.now() - (i + 1) * 3_600_000),
      })),
    });
    const oldest = `aged-device-${String(MAX - 1).padStart(4, "0")}`;
    await prisma.senderKeyEnvelope.create({
      data: {
        cartId: cart.body.id,
        senderId: userId,
        senderDevice: "aged-device-0000",
        recipientId: userId,
        recipientDevice: oldest,
        senderKey: KEY,
        iv: Buffer.from("0123456789ab").toString("base64"),
        payload: KEY,
      },
    });

    await agent
      .post(`/api/groups/${cart.body.id}/chat/devices`)
      .send({ deviceId: "fresh-device-0000", publicKey: KEY, signingKey: SIG })
      .expect(201);

    expect(await prisma.chatDevice.count({ where: { userId } })).toBe(MAX);
    expect(await prisma.senderKeyEnvelope.count({ where: { recipientDevice: oldest } })).toBe(0);
  });

  it("does not retire a device for registering again", async () => {
    const { agent, email } = await authedAgent();
    const userId = await idOf(email);
    for (let i = 0; i < 3; i++) {
      await agent
        .post("/api/users/chat-device")
        .send({ deviceId: "same-device-0000", publicKey: KEY, signingKey: SIG })
        .expect(201);
    }
    expect(await prisma.chatDevice.count({ where: { userId } })).toBe(1);
  });

  it("leaves other people's devices alone", async () => {
    const a = await authedAgent();
    const b = await authedAgent();
    const bId = await idOf(b.email);
    await prisma.chatDevice.createMany({
      data: Array.from({ length: MAX }, (_, i) => ({
        userId: bId,
        deviceId: `b-device-${String(i).padStart(6, "0")}`,
        publicKey: KEY,
        signingKey: SIG,
      })),
    });
    await a.agent
      .post("/api/users/chat-device")
      .send({ deviceId: "a-device-000000", publicKey: KEY, signingKey: SIG })
      .expect(201);
    expect(await prisma.chatDevice.count({ where: { userId: bId } })).toBe(MAX);
  });
});
