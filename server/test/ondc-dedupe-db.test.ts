import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { buildContext } from "../src/modules/ondc/context.js";
import { createAuthorizationHeader } from "../src/modules/ondc/signing.js";
import { createCallbacksRouter } from "../src/modules/ondc/callbacks.routes.js";
import { recordInbound } from "../src/modules/ondc/index.js";

// Duplicate detection lives in the database, not in one server's memory. A
// seller resending a message after a restart, or to a second server behind
// the same address, must still have it stored once.

const kp = crypto.generateKeyPairSync("ed25519");
const seller = {
  priv: kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
  pub: kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
};

/** One "server": its own router, so its own in-process state, sharing only the database. */
function server() {
  const a = express();
  a.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  a.use(createCallbacksRouter({ publicKeyFor: async () => seller.pub, record: recordInbound }));
  return a;
}

function message() {
  const ctx = buildContext({
    domain: "ONDC:RET11",
    action: "on_status",
    city: "std:080",
    transactionId: `t-${crypto.randomUUID()}`,
    bppId: "dedupe-seller.test",
    bppUri: "https://dedupe-seller.test",
  });
  return JSON.stringify({ context: ctx, message: { order: { id: "o1", state: "In-progress" } } });
}

const send = (a: express.Express, body: string) =>
  request(a)
    .post("/ondc/on_status")
    .set("Content-Type", "application/json")
    .set(
      "Authorization",
      createAuthorizationHeader(body, { subscriberId: "dedupe-seller.test", uniqueKeyId: "k", signingPrivateKey: seller.priv }),
    )
    .send(body);

const stored = (body: string) =>
  prisma.ondcTransaction.count({ where: { txnId: (JSON.parse(body).context as { transaction_id: string }).transaction_id } });

describe("ONDC duplicate detection in the database", () => {
  it("a resend after a restart is acknowledged and stored once", async () => {
    const body = message();
    expect((await send(server(), body)).status).toBe(200);
    // A fresh router: nothing in memory from the first delivery.
    const res = await send(server(), body);
    expect(res.status).toBe(200);
    expect(res.body.message.ack.status).toBe("ACK");
    expect(await stored(body)).toBe(1);
  });

  it("the same message reaching two servers at once is stored once", async () => {
    const body = message();
    const [a, b] = await Promise.all([send(server(), body), send(server(), body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await stored(body)).toBe(1);
  });

  it("two different messages in one transaction are both stored", async () => {
    const first = message();
    const ctx = JSON.parse(first).context;
    const second = JSON.stringify({ context: { ...ctx, message_id: crypto.randomUUID() }, message: { order: { id: "o1", state: "Completed" } } });
    const s = server();
    await send(s, first).expect(200);
    await send(s, second).expect(200);
    expect(await stored(first)).toBe(2);
  });
});
