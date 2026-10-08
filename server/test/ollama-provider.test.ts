import { afterEach, describe, expect, it, vi } from "vitest";

// Configured before the env module loads, as on the Oracle VM plan: a remote
// Ollama behind a reverse proxy that checks a token.
vi.hoisted(() => {
  process.env.OLLAMA_URL = "https://llm.flouna.test/";
  process.env.OLLAMA_API_KEY = "test-ollama-token";
});

import { OllamaProvider } from "../src/modules/chat/llm/ollama.js";
import { ollamaConfigured } from "../src/modules/chat/llm/index.js";
import { isPlainHttpRemote } from "../src/config/env.js";

// Ollama has no authentication of its own. Put on the internet for production,
// it sits behind a proxy that checks a token, so the provider has to send one,
// and nothing about it may quietly break the chat.

afterEach(() => vi.unstubAllGlobals());

function fakeOllama() {
  const seen: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ domain: "greeting", reply: "Hi" }) } }],
        }),
        { status: 200 },
      );
    }),
  );
  return seen;
}

describe("the Ollama provider on a remote server", () => {
  it("sends the token the proxy checks", async () => {
    const seen = fakeOllama();
    await new OllamaProvider().extractIntent("hello");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-ollama-token");
  });

  it("copes with a trailing slash on the URL", async () => {
    // "https://llm.example.com/" used to become "//v1/...", a 404 behind most proxies.
    const seen = fakeOllama();
    await new OllamaProvider().extractIntent("hello");
    expect(seen[0]!.url).toBe("https://llm.flouna.test/v1/chat/completions");
  });
});

describe("when Ollama joins the fallback chain", () => {
  it("joins wherever a URL is given", () => {
    expect(ollamaConfigured({ OLLAMA_URL: "https://llm.x", NODE_ENV: "production" })).toBe(true);
  });

  it("joins on a model name alone in development, meaning this machine", () => {
    expect(ollamaConfigured({ OLLAMA_MODEL: "flouna", NODE_ENV: "development" })).toBe(true);
  });

  it("stays out in production with only a model name, since there is no local model there", () => {
    expect(ollamaConfigured({ OLLAMA_MODEL: "flouna", NODE_ENV: "production" })).toBe(false);
  });
});

describe("spotting a token sent in the clear", () => {
  it.each([
    ["http://141.148.10.20:11434", true],
    ["http://llm.flouna.com", true],
    ["https://llm.flouna.com", false],
    ["http://localhost:11434", false],
    ["http://127.0.0.1:11434", false],
    ["not a url", false],
  ])("%s is plain http to a remote host: %s", (url, expected) => {
    expect(isPlainHttpRemote(url)).toBe(expected);
  });
});

// The 0.5B model sometimes leaves out "domain", and it is inferred from which
// parts of the answer are present. Present means filled in: small models often
// send "food": null alongside a real ride, and treating that key as present
// turned a ride into a food and ride combo.
describe("inferring a missing domain", () => {
  function answer(body: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), {
          status: 200,
        }),
      ),
    );
  }

  it("reads a ride with an empty food part as a ride", async () => {
    answer({
      reply: "Booking a cab",
      food: null,
      ride: { pickup: null, drop: "Airport", vehicle: "cab", priority: "balanced", scheduleAt: null },
    });
    const intent = await new OllamaProvider().extractIntent("cab to the airport");
    expect(intent.domain).toBe("ride");
  });

  it("still reads food and ride together as a combo", async () => {
    answer({
      reply: "On it",
      food: { item: "biryani", budgetPaise: null, dietary: "any", priority: "balanced" },
      ride: { pickup: null, drop: "Home", vehicle: "any", priority: "balanced", scheduleAt: null },
    });
    const intent = await new OllamaProvider().extractIntent("biryani and a cab home");
    expect(intent.domain).toBe("combo");
  });
});
