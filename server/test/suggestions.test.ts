import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// Pays for an order so it reaches a "confirmed" status the suggestion engine
// counts (simulated gateway is enabled in the test env).
async function order(
  agent: Awaited<ReturnType<typeof authedAgent>>["agent"],
  body: Record<string, unknown>,
) {
  const res = await agent.post("/api/orders").send(body).expect(201);
  const orderId = res.body.order.id as string;
  await agent.post("/api/payments/checkout").send({ orderId }).expect(200);
  await agent.post("/api/payments/simulate").send({ orderId, method: "upi" }).expect(200);
  return orderId;
}

describe("chat suggestions", () => {
  it("gives a new user three default suggestions", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get("/api/users/suggestions").expect(200);
    expect(res.body.suggestions).toHaveLength(3);
    // No history yet — every chip is generic, never a "Reorder …".
    for (const s of res.body.suggestions) {
      expect(s).toHaveProperty("label");
      expect(s).toHaveProperty("prompt");
      expect(s.label).not.toMatch(/^Reorder /);
    }
  });

  it("surfaces a reorder chip once a dish is bought twice", async () => {
    const { agent } = await authedAgent();
    // One order isn't a habit — still no reorder chip.
    await order(agent, { domain: "food", dishId: "masala-dosa", platform: "ondc" });
    let res = await agent.get("/api/users/suggestions").expect(200);
    expect(res.body.suggestions.some((s: { label: string }) => s.label.startsWith("Reorder"))).toBe(
      false,
    );

    // Second time makes it the user's usual — a personalized chip appears.
    await order(agent, { domain: "food", dishId: "masala-dosa", platform: "ondc" });
    res = await agent.get("/api/users/suggestions").expect(200);
    const reorder = res.body.suggestions.find((s: { label: string }) =>
      s.label.startsWith("Reorder"),
    );
    expect(reorder).toBeTruthy();
    expect(reorder.prompt).toMatch(/again$/);
    // Names the dish, so home can leave it out when the usual shortcut shows it.
    expect(reorder.dishId).toBe("masala-dosa");
  });

  it("never returns more than three suggestions", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get("/api/users/suggestions").expect(200);
    expect(res.body.suggestions.length).toBeLessThanOrEqual(3);
  });

  it("requires authentication", async () => {
    const { app } = await import("./helpers.js");
    const request = (await import("supertest")).default;
    await request(app).get("/api/users/suggestions").expect(401);
  });
});
