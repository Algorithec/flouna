import { describe, expect, it } from "vitest";
import { authedAgent, consoleAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";

// The developer console's model and ONDC screens. They read what is already
// recorded, and they sit next to secrets (signing keys, observability tokens),
// so beyond the numbers these check who can see them and that no secret value
// ever leaves the server.

describe("model operations", () => {
  it("counts answers by provider, fallbacks, and the watcher's agreement field by field", async () => {
    const { agent } = await consoleAgent("developer");
    const before = (await agent.get("/api/console/dev/model").expect(200)).body;

    const { email } = await authedAgent();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const session = await prisma.chatSession.create({ data: { userId: user.id, title: "ops test" } });
    await prisma.chatMessage.createMany({
      data: [
        { sessionId: session.id, role: "user", content: "biryani", provider: null },
        { sessionId: session.id, role: "assistant", content: "a", provider: "ops-test-model", providerDepth: 0 },
        { sessionId: session.id, role: "assistant", content: "b", provider: "ops-test-model", providerDepth: 1 },
        { sessionId: session.id, role: "assistant", content: "c", provider: "demo", providerDepth: -1 },
      ],
    });
    await prisma.intentWatch.createMany({
      data: [
        { watcher: "ops-test-watcher", primaryProvider: "x", message: "m1", agreed: true, fields: JSON.stringify({ "ops.test.field": true }), primaryIntent: "{}", watcherIntent: "{}", latencyMs: 100 },
        { watcher: "ops-test-watcher", primaryProvider: "x", message: "m2", agreed: false, fields: JSON.stringify({ "ops.test.field": false }), primaryIntent: "{}", watcherIntent: "{}", latencyMs: 300 },
        { watcher: "ops-test-watcher", primaryProvider: "x", message: "m3", agreed: false, fields: "{}", primaryIntent: "{}", watcherIntent: null, latencyMs: 9000, error: "timed out" },
      ],
    });

    const after = (await agent.get("/api/console/dev/model").expect(200)).body;
    expect(after.config.chain).toBeTypeOf("string");
    // User messages are not answers; the three assistant ones are.
    expect(after.traffic.answered - before.traffic.answered).toBe(3);
    expect(after.traffic.fellBack - before.traffic.fellBack).toBe(1);
    expect(after.traffic.allFailed - before.traffic.allFailed).toBe(1);
    expect(after.traffic.byProvider).toContainEqual({ provider: "ops-test-model", count: 2 });
    expect(after.watcher.readings - before.watcher.readings).toBe(3);
    expect(after.watcher.failed - before.watcher.failed).toBe(1);
    // The failed reading is not compared: one of two agreed on the field.
    expect(after.watcher.fields).toContainEqual({ field: "ops.test.field", compared: 2, agreementPct: 50 });
    // The customer's words are never part of this screen.
    expect(JSON.stringify(after)).not.toContain("biryani");
    expect(JSON.stringify(after)).not.toMatch(/"m[123]"/);
  });

  it("is hidden from customers and from operators without the developer role", async () => {
    const { agent: customer } = await authedAgent();
    await customer.get("/api/console/dev/model").expect(404);
    const { agent: admin } = await consoleAgent("admin");
    await admin.get("/api/console/dev/model").expect(404);
  });
});

describe("ONDC operations", () => {
  it("reports configuration as set or not set, never the values", async () => {
    const saved = { retail: env.ONDC_NO_TOKEN_RETAIL, ride: env.ONDC_NO_TOKEN_RIDE };
    const token = "nO-tOkEn-ops-test-6f3c1e";
    (env as { ONDC_NO_TOKEN_RETAIL?: string }).ONDC_NO_TOKEN_RETAIL = token;
    try {
      // A push that failed with the token echoed back in the error.
      await prisma.ondcNoLog.create({
        data: { domain: "ONDC:RET11", type: "on_search", payload: "{}", attempts: 2, lastError: `401 Unauthorized for Bearer ${token}` },
      });
      const { agent } = await consoleAgent("developer");
      const res = await agent.get("/api/console/dev/network").expect(200);
      const ops = res.body.ops;
      expect(ops.config.observabilityTokens.retail).toBe(true);
      expect(ops.observability.failing).toBeGreaterThanOrEqual(1);
      expect(ops.observability.lastFailure.lastError).toContain("[token]");
      expect(JSON.stringify(res.body)).not.toContain(token);
      for (const secret of [env.ONDC_SIGNING_PRIVATE_KEY, env.ONDC_ENCRYPTION_PRIVATE_KEY, env.JWT_ACCESS_SECRET]) {
        if (secret) expect(JSON.stringify(res.body)).not.toContain(secret);
      }
      // What the old screen showed is still there.
      expect(res.body.mode).toBeDefined();
      expect(res.body.domains.length).toBeGreaterThanOrEqual(2);
    } finally {
      (env as { ONDC_NO_TOKEN_RETAIL?: string }).ONDC_NO_TOKEN_RETAIL = saved.retail;
      (env as { ONDC_NO_TOKEN_RIDE?: string }).ONDC_NO_TOKEN_RIDE = saved.ride;
    }
  });

  it("counts live callbacks by action and outcome, and keeps simulated ones apart", async () => {
    const { agent } = await consoleAgent("developer");
    const before = (await agent.get("/api/console/dev/network").expect(200)).body.ops;
    const row = (status: string, simulated: boolean) => ({
      txnId: "ops-test-txn", messageId: `m-${Math.random()}`, action: "on_ops_test", domain: "ONDC:RET11", status, simulated,
    });
    await prisma.ondcTransaction.createMany({
      data: [row("ack", false), row("ack", false), row("nack", false), row("error", false), row("ack", true)],
    });
    const after = (await agent.get("/api/console/dev/network").expect(200)).body.ops;
    expect(after.callbacks.byAction).toContainEqual({ action: "on_ops_test", ack: 2, nack: 1, error: 1 });
    expect(after.callbacks.lastDay - before.callbacks.lastDay).toBe(4);
    expect(after.callbacks.simulated - before.callbacks.simulated).toBe(1);
  });

  it("is hidden from customers", async () => {
    const { agent } = await authedAgent();
    await agent.get("/api/console/dev/network").expect(404);
  });
});
