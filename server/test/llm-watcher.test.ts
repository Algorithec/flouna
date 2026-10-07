import { afterEach, describe, expect, it, vi } from "vitest";

// A remote Ollama set up as the watcher, as on the Oracle VM plan.
vi.hoisted(() => {
  process.env.LLM_WATCHER = "ollama";
  process.env.OLLAMA_URL = "https://llm.flouna.test";
  process.env.OLLAMA_MODEL = "flouna";
});

import { authedAgent, stepUp } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { compareIntents, watchIntent } from "../src/modules/chat/llm/watcher.js";
import { providerOrder } from "../src/modules/chat/llm/index.js";
import type { Intent, LlmProvider } from "../src/modules/chat/llm/types.js";

// The watcher: a model read beside the one answering customers, measured and
// never shown. These check the two promises that make it safe to switch on
// (it never changes a reply, and it never answers anyone) and that what it
// records is right.

afterEach(() => vi.unstubAllGlobals());

const food = (over: Partial<NonNullable<Intent["food"]>> = {}): Intent => ({
  domain: "food",
  reply: "On it",
  food: {
    item: "biryani",
    budgetPaise: 30000,
    maxEtaMinutes: 20,
    dietary: "any",
    priority: "price",
    ...over,
  } as NonNullable<Intent["food"]>,
});

describe("comparing two readings of one message", () => {
  it("agrees when every field the engine acts on matches", () => {
    expect(compareIntents(food(), food({ item: "Biryani " })).agreed).toBe(true);
  });

  it("names the field that differs, so a dropped limit is visible", () => {
    const r = compareIntents(food(), food({ maxEtaMinutes: null }));
    expect(r.agreed).toBe(false);
    expect(r.fields["food.maxEtaMinutes"]).toBe(false);
    expect(r.fields["food.budgetPaise"]).toBe(true);
  });

  it("does not mark a ride request on food fields neither reading has", () => {
    const ride: Intent = {
      domain: "ride",
      reply: "Booking",
      ride: { pickup: null, drop: "Airport", vehicle: "cab", budgetPaise: null, maxPickupMinutes: null, priority: "balanced", scheduleAt: null } as NonNullable<Intent["ride"]>,
    };
    const r = compareIntents(ride, ride);
    expect(Object.keys(r.fields).some((f) => f.startsWith("food."))).toBe(false);
  });

  it("marks a watcher that misses the food half of a combo", () => {
    const combo: Intent = { ...food(), domain: "combo", ride: { pickup: null, drop: "Home", vehicle: "any", budgetPaise: null, maxPickupMinutes: null, priority: "balanced", scheduleAt: null } as NonNullable<Intent["ride"]> };
    const rideOnly: Intent = { ...combo, domain: "ride", food: undefined };
    const r = compareIntents(combo, rideOnly);
    expect(r.fields.domain).toBe(false);
    expect(r.fields["food.item"]).toBe(false);
  });
});

describe("the watcher never answers a customer", () => {
  it("is left out of the chain that serves replies", () => {
    const order = providerOrder("anthropic", () => true, "ollama");
    expect(order).not.toContain("ollama");
    expect(order[0]).toBe("anthropic");
  });

  it("joins that chain as usual when it is not the watcher", () => {
    expect(providerOrder("anthropic", () => true)).toContain("ollama");
  });
});

describe("watching live chat", () => {
  /** The watcher's model, answering with a reading that differs from the rules. */
  function watcherAnswers(content: unknown, delayMs = 0) {
    const real = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes("llm.flouna.test")) return real(input, init);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
          { status: 200 },
        );
      }),
    );
  }

  async function latestWatch(message: string) {
    for (let i = 0; i < 60; i++) {
      const row = await prisma.intentWatch.findFirst({ where: { message }, orderBy: { createdAt: "desc" } });
      if (row) return row;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  it("leaves the customer's reply exactly as it would have been", async () => {
    const { agent } = await authedAgent();
    const message = `order biryani under 300 ${Date.now()}`;
    watcherAnswers({ domain: "ride", reply: "x", ride: { drop: "Somewhere", vehicle: "cab", pickup: null, priority: "balanced", scheduleAt: null } });

    const res = await agent.post("/api/chat/message").send({ message }).expect(200);
    expect(res.body.message.recommendation?.type).toBe("food");

    const row = await latestWatch(message);
    expect(row?.watcher).toBe("ollama");
    expect(row?.agreed).toBe(false);
    expect(JSON.parse(row!.fields).domain).toBe(false);
  });

  it("does not make the customer wait for it", async () => {
    // Proved without a stopwatch. The watcher's answer is held back until the
    // customer's reply has arrived; if the reply waited on the watcher it
    // would never arrive and the test would time out. The earlier version
    // timed the reply against a 2.5 second limit, which a busy machine
    // failed with nothing wrong.
    const { agent } = await authedAgent();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let asked = false;
    const real = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes("llm.flouna.test")) return real(input, init);
        asked = true;
        await held;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ domain: "food", reply: "x" }) } }] }),
          { status: 200 },
        );
      }),
    );

    const message = `biryani ${Date.now()}`;
    await agent.post("/api/chat/message").send({ message }).expect(200);
    // The watcher was asked, and the reply came back while it still had not answered.
    for (let i = 0; i < 40 && !asked; i++) await new Promise((r) => setTimeout(r, 25));
    expect(asked).toBe(true);
    release();
    expect(await latestWatch(message)).not.toBeNull();
  }, 15_000);

  it("records a failure and carries on when the watcher is down", async () => {
    const { agent } = await authedAgent();
    const message = `masala dosa ${Date.now()}`;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("llm.flouna.test")) throw new TypeError("fetch failed");
      return real(input, init);
    }));

    await agent.post("/api/chat/message").send({ message }).expect(200);
    const row = await latestWatch(message);
    expect(row?.error).toMatch(/fetch failed/);
    expect(row?.watcherIntent).toBeNull();
  });

  it("reads only the configured share of messages", async () => {
    const fake: LlmProvider = { name: "fake", extractIntent: async () => food() };
    expect(watchIntent("m", food(), "demo", { provider: fake, sample: 0.2, random: () => 0.5 })).toBeNull();
    expect(watchIntent("m", food(), "demo", { provider: fake, sample: 0.2, random: () => 0.1 })).not.toBeNull();
  });
});

describe("the operators' summary", () => {
  it("reports agreement overall and field by field, to super admins only", async () => {
    const fake: LlmProvider = { name: "summary-test", extractIntent: async () => food({ maxEtaMinutes: null }) };
    await watchIntent(`summary ${Date.now()}`, food(), "demo", { provider: fake, sample: 1 });

    const plain = await authedAgent();
    await plain.agent.get("/api/console/super/llm-watcher").expect(404);

    const boss = await authedAgent();
    await prisma.user.update({ where: { email: boss.email }, data: { role: "super_admin" } });
    await stepUp(boss.agent, boss.email);
    const res = await boss.agent.get("/api/console/super/llm-watcher?days=1").expect(200);

    expect(res.body.readings).toBeGreaterThan(0);
    expect(res.body.byField["food.maxEtaMinutes"].rate).toBeLessThan(1);
    expect(res.body.watchers).toContain("summary-test");
  });
});
