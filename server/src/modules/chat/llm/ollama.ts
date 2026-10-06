import { env } from "../../../config/env.js";
import { intentSchema, type Intent, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT } from "./prompt.js";

// Ollama — local fine-tuned Qwen model. Zero API cost, ~200ms latency.
// Uses the OpenAI-compatible endpoint that Ollama exposes at /v1/chat/completions.
export class OllamaProvider implements LlmProvider {
  name = "ollama";

  async extractIntent(userMessage: string): Promise<Intent> {
    const base = env.OLLAMA_URL ?? "http://localhost:11434";
    const model = env.OLLAMA_MODEL ?? "flouna";

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        max_tokens: 512,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}\n\nRespond ONLY with a JSON object: {"domain": "food"|"ride"|"shop"|"combo"|"greeting"|"out_of_scope", "reply": string, "food"?: {"item": string, "budgetPaise": number|null, "dietary": "veg"|"nonveg"|"any", "priority": "price"|"rating"|"speed"|"balanced"}, "ride"?: {"pickup": string|null, "drop": string, "vehicle": "bike"|"auto"|"cab"|"any", "priority": "price"|"rating"|"speed"|"balanced", "scheduleAt": "HH:mm"|null}, "shop"?: {"item": string, "budgetPaise": number|null, "category": "electronics"|"fashion"|"home"|"appliances"|"any", "priority": "price"|"rating"|"speed"|"balanced"}}. Set priority from the user's words: "rating" for top-rated/best, "price" for cheap/budget, "speed" for fast/quick, else "balanced".`,
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
    return intentSchema.parse(JSON.parse(content));
  }
}
