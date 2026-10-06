import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// "This is ₹64 above your stated budget" has to be about a budget the customer
// stated.
//
// The banner arrived on main, where a stated price is a soft filter. On this
// branch a stated price is a hard limit, enforced before ranking, and the
// search option it was computed from carries the weekly allowance instead: so
// it fired for people who had stated nothing in their message, and told them
// otherwise, beside the weekly-budget note that already covers that case.

async function chat(agent: Awaited<ReturnType<typeof authedAgent>>["agent"], message: string) {
  const res = await agent.post("/api/chat/message").send({ message }).expect(200);
  return res.body.message.recommendation;
}

describe("the over-budget banner", () => {
  it("does not claim a stated budget when only the weekly allowance applies", async () => {
    const { agent } = await authedAgent();
    // A weekly allowance smaller than any biryani, and no price in the message.
    await agent.put("/api/users/budget").send({ weeklyBudgetRupees: 100 }).expect(200);

    const rec = await chat(agent, "order biryani");
    expect(rec?.type).toBe("food");
    expect(rec.overBudgetPaise).toBeUndefined();
    // The allowance is still mentioned, by the note written for it.
    expect(rec.budgetNote).toMatch(/weekly/i);
  });

  it("never needs to fire for a price the customer named, because it is enforced", async () => {
    const { agent } = await authedAgent();
    const rec = await chat(agent, "biryani under ₹300");
    expect(rec?.type).toBe("food");
    expect(rec.best.effectivePaise).toBeLessThanOrEqual(30000);
    expect(rec.overBudgetPaise).toBeUndefined();
  });
});
