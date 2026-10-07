import { env } from "../../../config/env.js";
import { intentSchema, type Intent, type LlmProvider } from "./types.js";

// Ollama — local fine-tuned Qwen model. Zero API cost, ~200ms latency.
// The system prompt is baked into the Modelfile, so we only send the user message.
export class OllamaProvider implements LlmProvider {
  name = "ollama";

  async extractIntent(userMessage: string): Promise<Intent> {
    const base = env.OLLAMA_URL ?? "http://localhost:11434";
    const model = env.OLLAMA_MODEL ?? "flouna";

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        max_tokens: 512,
        temperature: 0,
        messages: [{ role: "user", content: userMessage }],
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

    // Normalize domain: the 1.5B model sometimes outputs "out of scope"
    // (with spaces) instead of "out_of_scope".
    if (typeof raw.domain === "string") {
      raw.domain = raw.domain.replace(/\s+/g, "_").toLowerCase();
    }

    // Infer domain from sub-objects when the model omits it.
    if (!raw.domain) {
      const hasFood = "food" in raw && raw.food != null;
      const hasRide = "ride" in raw && raw.ride != null;
      const hasShop = "shop" in raw && raw.shop != null;
      if (hasFood && hasRide) raw.domain = "combo";
      else if (hasFood) raw.domain = "food";
      else if (hasRide) raw.domain = "ride";
      else if (hasShop) raw.domain = "shop";
      else if (raw.reply) raw.domain = "greeting";
      else raw.domain = "out_of_scope";
    }
    if (!raw.reply) raw.reply = "";

    // Drop sub-objects that don't match the domain to avoid schema
    // validation failures on hallucinated fields.
    const domain = raw.domain as string;
    if (domain !== "food" && domain !== "combo") delete raw.food;
    if (domain !== "ride" && domain !== "combo") delete raw.ride;
    if (domain !== "shop") delete raw.shop;

    return intentSchema.parse(raw);
  }
}
