import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// The decision log used to answer "what did Flouna recommend" and stop there.
// A ranker learns from the gap between the option offered and the option
// taken, so without the second half there is no training signal at all and the
// weights can only ever be hand-set guesses.
//
// These tests are about that pairing existing and being trustworthy, not about
// the ranking itself.

/**
 * Both writes are deliberately fire-and-forget so a logging fault can never
 * fail a search or an order, which means the row lands just after the response
 * does. Poll rather than sleep a fixed amount: fast when it is quick, and not
 * flaky when the machine is busy.
 */
async function waitForRow<T>(read: () => Promise<T | null>, timeoutMs = 3000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await read();
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe("decision to outcome pairing", () => {
  it("a food search hands back the id of the ranking it just recorded", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get("/api/food/recommend?q=biryani").expect(200);

    expect(res.body.decisionId).toEqual(expect.any(String));

    const log = await waitForRow(() =>
      prisma.decisionLog.findUnique({ where: { id: res.body.decisionId } }),
    );
    expect(log).not.toBeNull();
    expect(log?.domain).toBe("food");
    // Nothing has been chosen yet, and that is a real state rather than a gap.
    expect(log?.selectedKey).toBeNull();
    expect(log?.orderId).toBeNull();
  });

  it("ordering the recommendation records what was actually chosen", async () => {
    const { agent } = await authedAgent();
    const rec = await agent.get("/api/food/recommend?q=biryani").expect(200);
    const decisionId = rec.body.decisionId as string;

    const order = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "dum-biryani", platform: "ondc", decisionId })
      .expect(201);

    const paired = await waitForRow(async () => {
      const row = await prisma.decisionLog.findUnique({ where: { id: decisionId } });
      return row?.selectedKey ? row : null;
    });

    expect(paired?.selectedKey).toBe("dum-biryani@ondc");
    expect(paired?.orderId).toBe(order.body.order.id);
    expect(paired?.selectedAt).toBeInstanceOf(Date);
  });

  it("the chosen option is read from the order, not taken from the caller", async () => {
    const { agent } = await authedAgent();
    const rec = await agent.get("/api/food/recommend?q=biryani").expect(200);
    const decisionId = rec.body.decisionId as string;

    // A caller trying to plant a different option in the training data. The
    // key is derived from the order being created, so the claim is ignored.
    await agent
      .post("/api/orders")
      .send({
        domain: "food",
        dishId: "dum-biryani",
        platform: "ondc",
        decisionId,
        selectedKey: "something-else@swiggy",
      })
      .expect(201);

    const paired = await waitForRow(async () => {
      const row = await prisma.decisionLog.findUnique({ where: { id: decisionId } });
      return row?.selectedKey ? row : null;
    });
    expect(paired?.selectedKey).toBe("dum-biryani@ondc");
  });

  it("an unknown or stale decision id never fails the order", async () => {
    const { agent } = await authedAgent();
    // Pruned, or quoted from an earlier session. The order is still good.
    await agent
      .post("/api/orders")
      .send({
        domain: "food",
        dishId: "dum-biryani",
        platform: "ondc",
        decisionId: "00000000-0000-4000-8000-000000000000",
      })
      .expect(201);
  });

  it("an order placed without a decision id is still accepted", async () => {
    const { agent } = await authedAgent();
    await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "dum-biryani", platform: "ondc" })
      .expect(201);
  });

  it("a search nobody orders from stays unpaired, which is itself the signal", async () => {
    const { agent } = await authedAgent();
    const rec = await agent.get("/api/food/recommend?q=pizza").expect(200);

    const log = await waitForRow(() =>
      prisma.decisionLog.findUnique({ where: { id: rec.body.decisionId } }),
    );
    expect(log?.selectedKey).toBeNull();
    expect(log?.selectedAt).toBeNull();
  });
});
