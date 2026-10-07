import { afterEach, describe, expect, it, vi } from "vitest";

// A paid model leads the chain, with hybrid routing switched on.
vi.hoisted(() => {
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.HYBRID_ROUTING = "true";
});

import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Hybrid routing: the rules answer what they read cleanly, in under a
// millisecond, and only the messages they might have misread wait for a
// model. These check both halves, and that a model failing still leaves the
// customer an answer.

afterEach(() => vi.unstubAllGlobals());

/** The model, answering every message as a food order, and counting calls. */
function model(answer: unknown = { domain: "food", reply: "On it", food: { item: "biryani", budgetPaise: 30000, maxEtaMinutes: null, dietary: "any", priority: "price" } }) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("api.deepseek.com")) return real(input, init);
      calls.push(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

/** Who the stored reply says read the message. */
async function servedBy(sessionId: string) {
  return prisma.chatMessage.findFirst({
    where: { sessionId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { provider: true, providerDepth: true },
  });
}

describe("hybrid routing", () => {
  it("answers a clearly read message by rules, without calling the model", async () => {
    const calls = model();
    const { agent } = await authedAgent();
    const res = await agent
      .post("/api/chat/message")
      .send({ message: "order biryani under 300" })
      .expect(200);
    expect(res.body.message.recommendation?.type).toBe("food");
    expect(calls).toHaveLength(0);
    // Labelled as the rules' reading, so the corpus never mistakes it for a
    // model's, and at depth 0 because nothing failed.
    expect(await servedBy(res.body.sessionId)).toEqual({ provider: "demo", providerDepth: 0 });
  });

  it("sends a message the rules doubt to the model", async () => {
    const calls = model();
    const { agent } = await authedAgent();
    const message = "biryani 300 only, spicy nahi";
    const res = await agent.post("/api/chat/message").send({ message }).expect(200);
    expect(calls).toHaveLength(1);
    // The model's reading is the one acted on: it found the ₹300 budget.
    expect(res.body.message.recommendation?.type).toBe("food");
    expect((await servedBy(res.body.sessionId))?.provider).toBe("deepseek");
  });

  it("still answers a doubtful message when the model is down", async () => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.deepseek.com")) throw new TypeError("fetch failed");
      return real(input, init);
    }));
    const { agent } = await authedAgent();
    const res = await agent
      .post("/api/chat/message")
      .send({ message: "biryani chahiye jaldi" })
      .expect(200);
    expect(res.body.message.recommendation?.type).toBe("food");
  });
});
