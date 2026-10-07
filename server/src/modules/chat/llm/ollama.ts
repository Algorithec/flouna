import { env } from "../../../config/env.js";
import { parseIntent, type Intent, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT, JSON_SHAPE } from "./prompt.js";

// Ollama — local fine-tuned Qwen model. Zero API cost, ~200ms latency.
// Uses the OpenAI-compatible endpoint that Ollama exposes at /v1/chat/completions.
export class OllamaProvider implements LlmProvider {
  name = "ollama";

  async extractIntent(userMessage: string): Promise<Intent> {
    // Trailing slashes trimmed: "https://llm.example.com/" would otherwise
    // request "//v1/..." and get a 404 from most proxies.
    const base = (env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
    const model = env.OLLAMA_MODEL ?? "flouna";

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        // Ollama has no authentication of its own, so a server reachable from
        // the internet sits behind a reverse proxy that checks this token.
        ...(env.OLLAMA_API_KEY ? { Authorization: `Bearer ${env.OLLAMA_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        max_tokens: 512,
        temperature: 0,
        messages: [
          {
            role: "system",
            // The shared shape, imported rather than pasted. The pasted copy was
            // already out of date, missing food.maxEtaMinutes, ride.budgetPaise
            // and ride.maxPickupMinutes, so limits a customer states could not
            // come back from this provider at all.
            content: `${SYSTEM_PROMPT}

${JSON_SHAPE}`,
          },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama request failed (${res.status})`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Ollama returned no content");
    const raw = JSON.parse(content) as Record<string, unknown>;

    // Small models often fill the parts they did not use with null ("food":
    // null beside a real ride). The schema rejects a null part, so one such
    // answer failed whole and chat fell back to another provider, and a key
    // that is present but empty would also have counted towards the domain.
    // An empty part is the same as an absent one.
    for (const part of ["food", "ride", "shop"]) {
      if (raw[part] === null) delete raw[part];
    }

    // The 0.5B model reliably outputs the right sub-objects but sometimes
    // omits the domain field. Infer it from whichever keys are present.
    if (!raw.domain) {
      const hasFood = "food" in raw;
      const hasRide = "ride" in raw;
      const hasShop = "shop" in raw;
      if (hasFood && hasRide) raw.domain = "combo";
      else if (hasFood) raw.domain = "food";
      else if (hasRide) raw.domain = "ride";
      else if (hasShop) raw.domain = "shop";
      else if (raw.reply) raw.domain = "greeting";
      else raw.domain = "out_of_scope";
    }
    if (!raw.reply) raw.reply = "";

    return parseIntent(raw);
  }
}
