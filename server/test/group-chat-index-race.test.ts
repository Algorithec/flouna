import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A position in a device's sender chain opens exactly one message. The route
// refused a reused position, but it checked by reading and then inserted, with
// nothing holding the position in between — and the column carries a plain
// index, not a unique one, so nothing underneath caught it either.
//
// Two sends at the same position at the same moment therefore both stored a
// row. The recipient ratchets the chain once, so one of the two is ciphertext
// nobody will ever open: a message that was sent, is shown as sent, and cannot
// be read. Written as the attack, which is one device and two requests in
// flight together.

const KEY = Buffer.from("k".repeat(64)).toString("base64");
const SIG = Buffer.from("s".repeat(64)).toString("base64");
const IV = Buffer.from("0123456789ab").toString("base64");

const DEVICE = "host-device-00001";

describe("one message per chain position", () => {
  it("stores one row when two sends race for the same position", async () => {
    const host = await authedAgent();
    const cart = await host.agent
      .post("/api/groups")
      .send({ platform: "ondc" })
      .expect(201);
    const cartId = cart.body.id as string;
    await host.agent
      .post(`/api/groups/${cartId}/chat/devices`)
      .send({ deviceId: DEVICE, publicKey: KEY, signingKey: SIG })
      .expect(201);

    const send = (ciphertext: string) =>
      host.agent.post(`/api/groups/${cartId}/chat/messages`).send({
        senderDevice: DEVICE,
        index: 7,
        iv: IV,
        ciphertext: Buffer.from(ciphertext).toString("base64"),
        signature: SIG,
      });

    const results = await Promise.all([send("first"), send("second")]);
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const rows = await prisma.groupMessage.count({
      where: { cartId, senderDevice: DEVICE, index: 7 },
    });
    expect(rows).toBe(1);
  });

  it("still accepts the next position", async () => {
    const host = await authedAgent();
    const cart = await host.agent
      .post("/api/groups")
      .send({ platform: "ondc" })
      .expect(201);
    await host.agent
      .post(`/api/groups/${cart.body.id}/chat/devices`)
      .send({ deviceId: DEVICE, publicKey: KEY, signingKey: SIG })
      .expect(201);
    for (const index of [0, 1, 2]) {
      await host.agent
        .post(`/api/groups/${cart.body.id}/chat/messages`)
        .send({
          senderDevice: DEVICE,
          index,
          iv: IV,
          ciphertext: Buffer.from(`m${index}`).toString("base64"),
          signature: SIG,
        })
        .expect(201);
    }
    const read = await host.agent
      .get(`/api/groups/${cart.body.id}/chat/messages`)
      .expect(200);
    expect(read.body.messages).toHaveLength(3);
  });
});
