import { afterEach, describe, expect, it, vi } from "vitest";

// "false" written out, which z.coerce.boolean would have read as true.
vi.hoisted(() => {
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.HYBRID_ROUTING = "false";
});

import { authedAgent } from "./helpers.js";
import { env } from "../src/config/env.js";

afterEach(() => vi.unstubAllGlobals());

describe("hybrid routing switched off", () => {
  it("is off for anything but true", () => {
    expect(env.HYBRID_ROUTING).toBe(false);
  });

  it("leaves every message to the model, however clear", async () => {
    let calls = 0;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("api.deepseek.com")) return real(input, init);
      calls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ domain: "food", reply: "On it", food: { item: "biryani", budgetPaise: 30000, maxEtaMinutes: null, dietary: "any", priority: "balanced" } }) } }] }),
        { status: 200 },
      );
    }));
    const { agent } = await authedAgent();
    await agent.post("/api/chat/message").send({ message: "order biryani under 300" }).expect(200);
    expect(calls).toBe(1);
  });
});
