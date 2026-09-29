import { env } from "../../../config/env.js";
import { intentSchema, type Intent, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT } from "./prompt.js";

// NVIDIA NIM — DeepSeek V4.1 Flash via the OpenAI-compatible NIM endpoint.
export class NvidiaProvider implements LlmProvider {
  name = "nvidia";

  async extractIntent(userMessage: string): Promise<Intent> {
    const res = await fetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-ai/deepseek-v4.1-flash",
          response_format: { type: "json_object" },
          max_tokens: 512,
          messages: [
            {
              role: "system",
              content: `${SYSTEM_PROMPT}\n\nRespond ONLY with a JSON object: {"domain": "food"|"ride"|"shop"|"combo"|"greeting"|"out_of_scope", "reply": string, "food"?: {"item": string, "budgetPaise": number|null, "dietary": "veg"|"nonveg"|"any", "priority": "price"|"rating"|"speed"|"balanced"}, "ride"?: {"pickup": string|null, "drop": string, "vehicle": "bike"|"auto"|"cab"|"any", "priority": "price"|"rating"|"speed"|"balanced", "scheduleAt": "HH:mm"|null}, "shop"?: {"item": string, "budgetPaise": number|null, "category": "electronics"|"fashion"|"home"|"appliances"|"any", "priority": "price"|"rating"|"speed"|"balanced"}}. Set priority from the user's words: "rating" for top-rated/best, "price" for cheap/budget, "speed" for fast/quick, else "balanced".`,
            },
            { role: "user", content: userMessage },
          ],
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`NVIDIA NIM request failed (${res.status})`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("NVIDIA NIM returned no content");
    return intentSchema.parse(JSON.parse(content));
  }
}
