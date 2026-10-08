import { beforeEach, describe, expect, it, vi } from "vitest";

// Push with a rotated VAPID key pair.
//
// A subscription is bound to the public key it was created with. After the
// keys are rotated, as the deploy notes require for production, every older
// subscription is refused by the push service with a 403 that the old code
// neither recognised nor cleaned up: each one stayed forever and failed on
// every send. The key a subscription was made with is now recorded, and one
// made with another key is removed instead of being tried.

vi.hoisted(() => {
  process.env.VAPID_PUBLIC_KEY = "current-public-key";
  process.env.VAPID_PRIVATE_KEY = "current-private-key";
});

const sent = vi.hoisted(() => [] as string[]);
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }) => {
      sent.push(sub.endpoint);
      return { statusCode: 201 };
    },
  },
}));

import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { sendPushToAll, sendPushToUser } from "../src/modules/notifications/push.service.js";

beforeEach(() => {
  sent.length = 0;
});

const keys = { p256dh: "p".repeat(40), auth: "a".repeat(16) };

async function userId(email: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
}

describe("push after the keys are rotated", () => {
  it("records the key a subscription was made with", async () => {
    const { agent, email } = await authedAgent();
    const endpoint = `https://fcm.googleapis.com/fcm/send/rec-${Date.now()}`;
    await agent.post("/api/notifications/subscribe").send({ endpoint, keys }).expect(201);
    const row = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint } });
    expect(row.vapidKey).toBe("current-public-key");
    expect(row.userId).toBe(await userId(email));
  });

  it("removes a subscription made with an old key instead of sending to it", async () => {
    const { email } = await authedAgent();
    const id = await userId(email);
    const stale = `https://fcm.googleapis.com/fcm/send/stale-${Date.now()}`;
    const fresh = `https://fcm.googleapis.com/fcm/send/fresh-${Date.now()}`;
    await prisma.pushSubscription.createMany({
      data: [
        { userId: id, endpoint: stale, ...keys, vapidKey: "old-public-key" },
        { userId: id, endpoint: fresh, ...keys, vapidKey: "current-public-key" },
      ],
    });

    await sendPushToUser(id, { title: "t", body: "b" });

    expect(sent).toEqual([fresh]);
    expect(await prisma.pushSubscription.findUnique({ where: { endpoint: stale } })).toBeNull();
  });

  it("does the same for an announcement to everyone", async () => {
    const { email } = await authedAgent();
    const stale = `https://fcm.googleapis.com/fcm/send/stale-all-${Date.now()}`;
    await prisma.pushSubscription.create({
      data: { userId: await userId(email), endpoint: stale, ...keys, vapidKey: "old-public-key" },
    });
    const r = await sendPushToAll({ title: "t", body: "b" });
    expect(sent).not.toContain(stale);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(await prisma.pushSubscription.findUnique({ where: { endpoint: stale } })).toBeNull();
  });
});
