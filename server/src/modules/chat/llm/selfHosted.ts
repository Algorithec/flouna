import { env } from "../../../config/env.js";
import { parseIntent, type Intent, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT, JSON_SCHEMA } from "./prompt.js";

// A model we run ourselves, reached over an OpenAI-compatible endpoint.
//
// This is the seam the in-house engine plugs into. vLLM, SGLang, TGI and
// llama.cpp all speak this shape, so the weights and the serving stack can
// change without this file changing: the architecture guide is explicit that
// the model is expected to move over time, and pinning a vendor SDK here would
// have made that a rewrite rather than an environment variable.
//
// The important difference from the hosted providers is guided decoding. They
// are asked to return JSON and usually do. Here the schema is handed to the
// sampler, which cannot emit a token that would break it, so the structure is
// enforced rather than requested. That is the strongest version of the
// firewall's first layer, and it is only available because we run the server.
//
// Falls back like any other provider: a timeout or a bad response throws, and
// FallbackProvider moves down the chain to whatever is configured behind it,
// ending at the rule-based engine, which needs nothing at all.

/** Serving stacks disagree on where guided decoding lives in the request. */
type GuidedRequest = Record<string, unknown>;

export class SelfHostedProvider implements LlmProvider {
  name = "self-hosted";

  private endpoint(): string {
    const base = (env.SELF_HOSTED_LLM_URL ?? "").replace(/\/+$/, "");
    // Accept either the server root or a full chat-completions URL, because
    // both are what people paste out of a vLLM readme.
    return base.endsWith("/chat/completions") ? base : `${base}/v1/chat/completions`;
  }

  async extractIntent(userMessage: string): Promise<Intent> {
    if (!env.SELF_HOSTED_LLM_URL) {
      throw new Error("SELF_HOSTED_LLM_URL is not configured");
    }

    const body: GuidedRequest = {
      model: env.SELF_HOSTED_LLM_MODEL,
      // Deterministic on purpose. This is a classifier, not a writer: the same
      // sentence should produce the same intent today and next week, or the
      // evaluation set stops measuring anything stable.
      temperature: 0,
      max_tokens: 512,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      // vLLM and SGLang read this. Ignored by servers that do not support it,
      // which is why response_format is sent as well.
      guided_json: JSON_SCHEMA,
      response_format: { type: "json_object" },
    };

    const res = await fetch(this.endpoint(), {
      method: "POST",
      // fetch() never times out on its own. Without this a hung connection
      // blocks here forever rather than rejecting, and the fallback chain
      // never gets the failure it needs in order to move on.
      signal: AbortSignal.timeout(env.SELF_HOSTED_LLM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        // vLLM only enforces this when started with --api-key. Sent when we
        // have one so the server can be locked down without a code change.
        ...(env.SELF_HOSTED_LLM_API_KEY
          ? { Authorization: `Bearer ${env.SELF_HOSTED_LLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Carry the server's own explanation. A model that is still loading, an
      // unknown model name and an out-of-memory refusal all arrive as a bare
      // status otherwise, and they need very different responses.
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Self-hosted model request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Self-hosted model returned no content");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Guided decoding should make this impossible, so reaching it means the
      // server silently ignored guided_json. Say so, rather than reporting it
      // as a model that cannot count braces.
      throw new Error(
        "Self-hosted model returned content that is not JSON, so guided decoding is probably not in effect",
      );
    }
    // Validated regardless. Guided decoding constrains the shape, not the
    // meaning, and this is the boundary the rest of the product trusts.
    return parseIntent(parsed);
  }
}
