import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// Two routes carry more than a form's worth of data, and both were written as
// though a parser mounted on the route could raise the API's 100 KB body
// ceiling. It cannot: the app-level parser runs before routing and has already
// refused the body.
//
// So a complaint could not carry a photo — every phone photo is larger than
// 100 KB, and attaching one answered "That request was too large" — and the
// encrypted chat could not hand a conversation's history to a second device,
// which is the whole of what that feature does.
//
// Written as the attack on the ceiling rather than on the crypto or the image:
// the server cannot read either, so the only thing it can get wrong is the size.

const KEY = Buffer.from("k".repeat(64)).toString("base64");
const SIG = Buffer.from("s".repeat(64)).toString("base64");
const IV = Buffer.from("0123456789ab").toString("base64");

const DEV_A = "host-device-00001";
const DEV_B = "host-device-00002";

/** Valid base64 of a given length, which is what the schema checks for. */
const payloadOf = (chars: number) => "A".repeat(chars);

describe("encrypted history sync carries a real conversation", () => {
  it("accepts a sealed history larger than the ordinary body ceiling", async () => {
    const host = await authedAgent();
    const cart = await host.agent
      .post("/api/groups")
      .send({ platform: "ondc" })
      .expect(201);
    const cartId = cart.body.id as string;

    for (const deviceId of [DEV_A, DEV_B]) {
      await host.agent
        .post(`/api/groups/${cartId}/chat/devices`)
        .send({ deviceId, publicKey: KEY, signingKey: SIG })
        .expect(201);
    }

    const res = await host.agent
      .post(`/api/groups/${cartId}/chat/history`)
      .send({
        fromDevice: DEV_A,
        toDevice: DEV_B,
        senderKey: KEY,
        iv: IV,
        // Comfortably past 100 KB, and inside what the route's schema allows.
        payload: payloadOf(300_000),
      });
    expect(res.status).toBe(201);
    expect(res.body.written).toBe(true);

    const back = await host.agent
      .get(`/api/groups/${cartId}/chat/keys?deviceId=${DEV_B}`)
      .expect(200);
    expect(back.body.history.payload).toHaveLength(300_000);
  });

  it("still refuses an oversized body on an ordinary route", async () => {
    const host = await authedAgent();
    const res = await host.agent
      .post("/api/chat/message")
      .send({ message: "x".repeat(200_000) });
    expect(res.status).toBe(413);
  });

  it("still refuses a history payload past what its own schema allows", async () => {
    const host = await authedAgent();
    const cart = await host.agent
      .post("/api/groups")
      .send({ platform: "ondc" })
      .expect(201);
    for (const deviceId of [DEV_A, DEV_B]) {
      await host.agent
        .post(`/api/groups/${cart.body.id}/chat/devices`)
        .send({ deviceId, publicKey: KEY, signingKey: SIG })
        .expect(201);
    }
    const res = await host.agent
      .post(`/api/groups/${cart.body.id}/chat/history`)
      .send({
        fromDevice: DEV_A,
        toDevice: DEV_B,
        senderKey: KEY,
        iv: IV,
        payload: payloadOf(450_000),
      });
    expect(res.status).toBe(400);
  });
});

describe("a complaint can carry the photo that proves it", () => {
  it("accepts a photo-sized attachment", async () => {
    const { agent } = await authedAgent();
    const made = await agent
      .post("/api/complaints")
      .send({ category: "ITEM", description: "the food arrived cold" })
      .expect(201);

    const res = await agent
      .post(`/api/complaints/${made.body.complaint.id}/evidence`)
      .send({ dataUrl: "data:image/png;base64," + "A".repeat(400_000) });
    expect(res.status).toBe(201);
    expect(res.body.evidence.sizeBytes).toBeGreaterThan(100_000);
  });

  it("still refuses something past the published file cap", async () => {
    const { agent } = await authedAgent();
    const made = await agent
      .post("/api/complaints")
      .send({ category: "ITEM", description: "the food arrived cold" })
      .expect(201);
    const res = await agent
      .post(`/api/complaints/${made.body.complaint.id}/evidence`)
      .send({ dataUrl: "data:image/png;base64," + "A".repeat(9_000_000) });
    expect(res.status).toBe(413);
  });
});
