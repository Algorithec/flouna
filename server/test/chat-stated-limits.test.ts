import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// Stated limits, end to end through the chat route with the rule engine.
//
// The unit suites prove each piece. These prove the pieces are connected, and
// cover the failures that only exist once they are: a misread number emptying
// a real search, a stated price quietly exceeded because it shared a parameter
// with the weekly allowance, and a customer told there is no biryani when
// there is, just none under their price.

async function chat(message: string, weeklyBudgetRupees?: number) {
  const { agent } = await authedAgent();
  if (weeklyBudgetRupees !== undefined) {
    await agent.put("/api/users/budget").send({ weeklyBudgetRupees }).expect(200);
  }
  const res = await agent.post("/api/chat/message").send({ message }).expect(200);
  return res.body.message;
}

describe("numbers that are not prices do not empty a search", () => {
  // Each of these was once read as a price. With a stated price now enforced,
  // that misreading would return nothing at all. The guide's own example
  // phrase is the first.
  it.each([
    "chicken biryani within 35 minutes",
    "order 12 samosas",
    "dinner for 10 people",
    "pizza delivered in 45 mins",
  ])("%s still gets a recommendation", async (message) => {
    const msg = await chat(message);
    expect(msg.recommendation?.type).toBe("food");
    expect(msg.recommendation.best).toBeDefined();
  });
});

describe("a stated price is enforced", () => {
  it("never recommends above it", async () => {
    const msg = await chat("biryani under ₹300");
    expect(msg.recommendation?.type).toBe("food");
    expect(msg.recommendation.best.effectivePaise).toBeLessThanOrEqual(30000);
    for (const alt of msg.recommendation.alternatives) {
      expect(alt.effectivePaise).toBeLessThanOrEqual(30000);
    }
  });

  it("takes precedence over the weekly allowance, and is not waived by it", async () => {
    // A ₹150 week cannot fit any biryani and would waive itself. The ₹300 the
    // customer named must still hold after that happens.
    const msg = await chat("biryani under ₹300", 150);
    expect(msg.recommendation?.type).toBe("food");
    expect(msg.recommendation.best.effectivePaise).toBeLessThanOrEqual(30000);
  });

  it("says what exists rather than claiming there is nothing", async () => {
    const msg = await chat("biryani under ₹50");
    // Stored as null when absent, not undefined.
    expect(msg.recommendation ?? null).toBeNull();
    // Not the unmatched-dish reply, which would be false here.
    expect(msg.content).not.toMatch(/couldn't find/i);
    expect(msg.content).toMatch(/under ₹50/);
    expect(msg.content).toMatch(/closest is ₹\d+/i);
  });
});

describe("the weekly allowance still behaves as it did", () => {
  it("is still waived, with an honest note, when no price was stated", async () => {
    // The Budget Guardian contract from budget-chat.test.ts, checked again
    // here because the parameter it used to share was split.
    const msg = await chat("order biryani", 150);
    expect(msg.recommendation?.type).toBe("food");
    expect(msg.recommendation.budgetNote).toMatch(/over your weekly food budget/i);
  });
});

describe("a latest delivery time", () => {
  it("never recommends anything slower", async () => {
    const msg = await chat("biryani within 35 minutes");
    expect(msg.recommendation?.type).toBe("food");
    expect(msg.recommendation.best.etaMinutes).toBeLessThanOrEqual(35);
    for (const alt of msg.recommendation.alternatives) {
      expect(alt.etaMinutes).toBeLessThanOrEqual(35);
    }
  });
});

describe("rides", () => {
  it("enforces a pickup limit on every ride offered", async () => {
    const msg = await chat("cab to hitec city, dont want to wait more than 9 minutes");
    if (msg.recommendation) {
      expect(msg.recommendation.quotes.length).toBeGreaterThan(0);
      for (const q of msg.recommendation.quotes) {
        expect(q.pickupEtaMinutes).toBeLessThanOrEqual(9);
      }
    } else {
      expect(msg.content).toMatch(/pick you up within 9 minutes/);
    }
  });

  it("explains an impossible pickup limit instead of printing undefined", async () => {
    const msg = await chat("cab to hitec city, dont want to wait more than 1 minute");
    expect(msg.content).not.toMatch(/undefined/);
    expect(msg.content).toMatch(/pick you up within 1 minutes?/);
  });

  it("carries a stated fare without holding placeholder fares to it", async () => {
    // Chat prices a typical 8 km trip. Filtering those fares against the
    // rider's limit would be a promise about a route nobody has entered.
    const withLimit = await chat("cab to hitec city under ₹100");
    const withoutLimit = await chat("cab to hitec city");
    expect(withLimit.recommendation.fareLimitPaise).toBe(10000);
    expect(withLimit.recommendation.quotes.length).toBe(
      withoutLimit.recommendation.quotes.length,
    );
    // And the reply does not claim a check that does not happen.
    expect(withLimit.recommendation.why).not.toMatch(/checked/i);
  });
});

describe("a combo follows the same rules as its halves", () => {
  it("enforces a stated food price in a food and ride request", async () => {
    const msg = await chat("biryani under ₹300 and a cab home");
    expect(msg.recommendation?.type).toBe("combo");
    expect(msg.recommendation.food.best.effectivePaise).toBeLessThanOrEqual(30000);
  });
});
