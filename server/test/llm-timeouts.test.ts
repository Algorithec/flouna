import { afterEach, describe, expect, it, vi } from "vitest";

// A short limit for the test; production defaults to four seconds.
vi.hoisted(() => {
  process.env.LLM_TIMEOUT_MS = "300";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.GOOGLE_AI_API_KEY = "test-key";
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.OLLAMA_URL = "https://llm.flouna.test";
});

import { AnthropicProvider } from "../src/modules/chat/llm/anthropic.js";
import { DeepseekProvider } from "../src/modules/chat/llm/deepseek.js";
import { GoogleProvider } from "../src/modules/chat/llm/google.js";
import { NvidiaProvider } from "../src/modules/chat/llm/nvidia.js";
import { OllamaProvider } from "../src/modules/chat/llm/ollama.js";

// A slow model must hand over to the next one quickly.
//
// Chat waits on the model before it can answer. Each hosted provider waited
// twenty seconds before giving up, and the Anthropic client also retried twice
// on its own, so one hung call could hold a customer's reply for about a minute
// before the fallback chain even started. The chain is the retry; each
// provider gets one bounded attempt.

afterEach(() => vi.unstubAllGlobals());

/** An upstream that accepts the request and never answers. */
function hangingUpstream() {
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
    ),
  );
}

describe("a provider that never answers", () => {
  it.each([
    ["DeepSeek", () => new DeepseekProvider()],
    ["Google", () => new GoogleProvider()],
    ["NVIDIA", () => new NvidiaProvider()],
    ["Ollama", () => new OllamaProvider()],
  ])("%s gives up within the configured limit", async (_, make) => {
    hangingUpstream();
    const started = Date.now();
    await expect(make().extractIntent("biryani")).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("the Anthropic client makes one bounded attempt, with no hidden retries", () => {
    const client = (new AnthropicProvider() as unknown as { client: { timeout: number; maxRetries: number } }).client;
    expect(client.timeout).toBe(300);
    expect(client.maxRetries).toBe(0);
  });
});
