import { describe, expect, it, vi } from "vitest";
import { FallbackProvider } from "../src/modules/chat/llm/fallback.js";
import type { Intent, LlmProvider } from "../src/modules/chat/llm/types.js";

// A fallback chain that is never exercised is just an assumption. An expired
// Anthropic key once sent every request to the rule-based engine without
// anything failing loudly, which is the failure this exists to prevent.

const intent = (reply: string): Intent => ({ domain: "greeting", reply });

const ok = (name: string): LlmProvider => ({
  name,
  extractIntent: vi.fn(async () => intent(`from ${name}`)),
});

const broken = (name: string, message = "provider is down"): LlmProvider => ({
  name,
  extractIntent: vi.fn(async () => {
    throw new Error(message);
  }),
});

describe("LLM provider chain", () => {
  it("uses the first provider and does not touch the rest", async () => {
    const second = ok("deepseek");
    const chain = new FallbackProvider([ok("anthropic"), second]);

    expect((await chain.extractIntent("hi")).reply).toBe("from anthropic");
    expect(second.extractIntent).not.toHaveBeenCalled();
  });

  it("falls through to the next provider when one fails", async () => {
    const chain = new FallbackProvider([broken("anthropic"), ok("deepseek")]);
    expect((await chain.extractIntent("hi")).reply).toBe("from deepseek");
  });

  it("keeps going down the chain, not just one step", async () => {
    const chain = new FallbackProvider([
      broken("anthropic"),
      broken("deepseek"),
      ok("google"),
    ]);
    expect((await chain.extractIntent("hi")).reply).toBe("from google");
  });

  it("throws when every provider fails, so the caller can degrade", async () => {
    // Swallowing here would fabricate an intent. The route already falls back
    // to the rule-based engine, and that decision belongs to it.
    const chain = new FallbackProvider([
      broken("anthropic", "429 rate limited"),
      broken("deepseek", "503"),
    ]);
    await expect(chain.extractIntent("hi")).rejects.toThrow("503");
  });

  it("reports the chain in its name, so logs say what is configured", () => {
    expect(new FallbackProvider([ok("anthropic"), ok("deepseek")]).name).toBe(
      "anthropic -> deepseek",
    );
  });

  it("refuses to be constructed empty rather than failing at request time", () => {
    expect(() => new FallbackProvider([])).toThrow(/at least one/i);
  });

  it("tries every provider exactly once per request", async () => {
    const a = broken("anthropic");
    const b = ok("deepseek");
    const chain = new FallbackProvider([a, b]);
    await chain.extractIntent("hi");
    expect(a.extractIntent).toHaveBeenCalledTimes(1);
    expect(b.extractIntent).toHaveBeenCalledTimes(1);
  });
});

// A provider that is down must stop being tried on every request.
//
// Without this, the chain pays a dead provider's full timeout every single
// time. The self-hosted model is the sharp case: it is allowed thirty seconds
// because a cold box is worth waiting for, so an unreachable one turns every
// message into a thirty second wait. The product is not down, it just behaves
// as though it is. Section 12 of the architecture guide asks for exactly this.
describe("standing down a failing provider", () => {
  it("stops calling a provider after repeated failures", async () => {
    const dead = broken("dead");
    const alive = ok("alive");
    const chain = new FallbackProvider([dead, alive]);

    for (let i = 0; i < 6; i++) {
      expect((await chain.extractIntent("hi")).reply).toBe("from alive");
    }

    // Three strikes, then stood down: it is not called again after that.
    expect(dead.extractIntent).toHaveBeenCalledTimes(3);
    expect(alive.extractIntent).toHaveBeenCalledTimes(6);
  });

  it("a single failure is not enough to stand a provider down", async () => {
    const flaky = {
      name: "flaky",
      extractIntent: vi
        .fn()
        .mockRejectedValueOnce(new Error("blip"))
        .mockResolvedValue(intent("from flaky")),
    };
    const chain = new FallbackProvider([flaky, ok("backup")]);

    expect((await chain.extractIntent("hi")).reply).toBe("from backup");
    // Recovered, and still first in line: one timeout is ordinary.
    expect((await chain.extractIntent("hi")).reply).toBe("from flaky");
  });

  it("clears the record once a provider answers again", async () => {
    const flaky = {
      name: "flaky",
      extractIntent: vi
        .fn()
        .mockRejectedValueOnce(new Error("a"))
        .mockRejectedValueOnce(new Error("b"))
        .mockResolvedValue(intent("from flaky")),
    };
    const chain = new FallbackProvider([flaky, ok("backup")]);

    await chain.extractIntent("hi");
    await chain.extractIntent("hi");
    // Two failures, then a success: the count resets rather than carrying
    // forward into a stand-down it no longer deserves.
    expect((await chain.extractIntent("hi")).reply).toBe("from flaky");
    for (let i = 0; i < 3; i++) {
      expect((await chain.extractIntent("hi")).reply).toBe("from flaky");
    }
  });
});

// When every provider is standing down.
//
// Clearing all stand-downs before throwing, as this once did, meant a request
// arriving just before they expired got an error and the next one called every
// provider still believed to be down. Raised in review.
describe("every provider standing down", () => {
  it("throws without calling anyone and keeps the stand-downs in place", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = broken("a");
    const b = broken("b");
    const chain = new FallbackProvider([a, b]);

    // Three failures each stands both down.
    for (let i = 0; i < 3; i++) await expect(chain.extractIntent("hi")).rejects.toThrow();
    expect(a.extractIntent).toHaveBeenCalledTimes(3);
    expect(b.extractIntent).toHaveBeenCalledTimes(3);

    // Standing down: two more requests call nobody, and the second is not
    // treated as a fresh start.
    await expect(chain.extractIntent("hi")).rejects.toThrow(/standing down/);
    await expect(chain.extractIntent("hi")).rejects.toThrow(/standing down/);
    expect(a.extractIntent).toHaveBeenCalledTimes(3);
    expect(b.extractIntent).toHaveBeenCalledTimes(3);

    // Once the stand-down has run its course, they are tried again.
    vi.setSystemTime(new Date("2026-09-15T10:00:31Z"));
    await expect(chain.extractIntent("hi")).rejects.toThrow();
    expect(a.extractIntent).toHaveBeenCalledTimes(4);

    err.mockRestore();
    warn.mockRestore();
    vi.useRealTimers();
  });
});
