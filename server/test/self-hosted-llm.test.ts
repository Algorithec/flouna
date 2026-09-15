import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider we plug our own model into. Exercised against a stand-in
// server rather than real weights: everything worth testing here is the
// contract with an OpenAI-compatible endpoint, and none of it needs a GPU.

const ENDPOINT = "http://gpu.internal:8000";

async function loadProvider(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries({
    SELF_HOSTED_LLM_URL: ENDPOINT,
    SELF_HOSTED_LLM_MODEL: "Qwen/Qwen3.5-9B",
    ...overrides,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { SelfHostedProvider } = await import("../src/modules/chat/llm/selfHosted.js");
  return new SelfHostedProvider();
}

function reply(intent: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(intent) } }] }),
    text: async () => "",
  } as unknown as Response;
}

const VALID = {
  domain: "food",
  reply: "Got it, finding the best deal for you.",
  food: { item: "biryani", budgetPaise: 30000, dietary: "nonveg", priority: "price" },
};

const originalEnv = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("self-hosted model provider", () => {
  it("parses a well-formed intent", async () => {
    fetchMock.mockResolvedValue(reply(VALID));
    const provider = await loadProvider();
    const intent = await provider.extractIntent("cheap biryani under 300");
    expect(intent.domain).toBe("food");
    expect(intent.food?.priority).toBe("price");
  });

  it("hands the schema to the sampler, so the shape is enforced not requested", async () => {
    fetchMock.mockResolvedValue(reply(VALID));
    const provider = await loadProvider();
    await provider.extractIntent("hi");

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    // The whole reason to run our own server: guided decoding cannot emit a
    // token that breaks the schema.
    expect(body.guided_json).toBeDefined();
    expect(body.guided_json.properties.domain.enum).toContain("out_of_scope");
    // Deterministic, because this is a classifier and the eval set has to mean
    // the same thing twice.
    expect(body.temperature).toBe(0);
  });

  it("accepts either a server root or a full completions URL", async () => {
    fetchMock.mockResolvedValue(reply(VALID));

    await (await loadProvider()).extractIntent("hi");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${ENDPOINT}/v1/chat/completions`);

    fetchMock.mockClear();
    await (
      await loadProvider({ SELF_HOSTED_LLM_URL: `${ENDPOINT}/v1/chat/completions` })
    ).extractIntent("hi");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${ENDPOINT}/v1/chat/completions`);

    fetchMock.mockClear();
    await (await loadProvider({ SELF_HOSTED_LLM_URL: `${ENDPOINT}/` })).extractIntent("hi");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${ENDPOINT}/v1/chat/completions`);
  });

  it("sends a bearer token only when one is configured", async () => {
    fetchMock.mockResolvedValue(reply(VALID));

    await (await loadProvider()).extractIntent("hi");
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBeUndefined();

    fetchMock.mockClear();
    await (await loadProvider({ SELF_HOSTED_LLM_API_KEY: "s3cret" })).extractIntent("hi");
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer s3cret");
  });

  it("carries the server's own explanation into the error", async () => {
    // A model still loading, an unknown model name and an out-of-memory
    // refusal all arrive as a bare status otherwise, and they need very
    // different responses from whoever is on call.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "The model is still being loaded",
      json: async () => ({}),
    } as unknown as Response);

    const provider = await loadProvider();
    await expect(provider.extractIntent("hi")).rejects.toThrow(/503.*still being loaded/);
  });

  it("names guided decoding when the reply is not JSON at all", async () => {
    // Guided decoding makes this impossible, so reaching it means the server
    // ignored guided_json rather than that the model cannot count braces.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Sure! Here you go:" } }] }),
      text: async () => "",
    } as unknown as Response);

    const provider = await loadProvider();
    await expect(provider.extractIntent("hi")).rejects.toThrow(/guided decoding/i);
  });

  it("still validates the meaning, because guided decoding only fixes the shape", async () => {
    fetchMock.mockResolvedValue(reply({ domain: "astrology", reply: "ok" }));
    const provider = await loadProvider();
    await expect(provider.extractIntent("hi")).rejects.toThrow();
  });

  it("refuses clearly when no endpoint is configured", async () => {
    const provider = await loadProvider({ SELF_HOSTED_LLM_URL: undefined });
    await expect(provider.extractIntent("hi")).rejects.toThrow(/SELF_HOSTED_LLM_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects rather than hanging, so the fallback chain can move on", async () => {
    // fetch() never times out on its own. Without the abort signal a hung
    // server blocks forever and the chain never gets a failure to act on.
    fetchMock.mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      }),
    );
    const provider = await loadProvider();
    await expect(provider.extractIntent("hi")).rejects.toThrow(/abort|timeout/i);
  });
});

// A self-hosted failure moves the chain on.
//
// Asked for in review. The tests above prove the provider throws; this proves
// the chain responds to those throws by serving from the next provider, for
// each way a self-hosted model actually fails.
describe("self-hosted failures inside the fallback chain", () => {
  const backup = (): import("../src/modules/chat/llm/types.js").LlmProvider => ({
    name: "backup",
    extractIntent: vi.fn(async () => ({ domain: "greeting" as const, reply: "from backup" })),
  });

  it.each([
    ["times out", () => fetchMock.mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))],
    ["returns an HTTP error", () => fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}), text: async () => "overloaded" } as unknown as Response)],
    ["returns output that breaks the schema", () => fetchMock.mockResolvedValue(reply({ domain: "not-a-domain", reply: 42 }))],
  ])("serves from the next provider when the model %s", async (_, arrange) => {
    arrange();
    const selfHosted = await loadProvider();
    const { FallbackProvider } = await import("../src/modules/chat/llm/fallback.js");
    const next = backup();
    const chain = new FallbackProvider([selfHosted, next]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const { intent, served } = await chain.extractIntentTraced("hi");

    expect(intent.reply).toBe("from backup");
    expect(served).toEqual({ provider: "backup", depth: 1 });
    expect(fetchMock).toHaveBeenCalled();
    expect(next.extractIntent).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
