import { env } from "../../../config/env.js";
import { parseIntent, type Intent, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT, JSON_SHAPE } from "./prompt.js";

// NVIDIA NIM — DeepSeek V4.1 Flash via the OpenAI-compatible NIM endpoint.
export class NvidiaProvider implements LlmProvider {
  name = "nvidia";

  async extractIntent(userMessage: string): Promise<Intent> {
    const res = await fetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        method: "POST",
        signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
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
              // The shared shape, not a copy of it. This provider arrived
              // with the spec pasted inline, and the copy was already out of
              // date: it omitted food.maxEtaMinutes, ride.budgetPaise and
              // ride.maxPickupMinutes, so with this provider selected the
              // limits customers state ("in 20 minutes", "under ₹200", "pick
              // me up in 5") could not be returned at all. zod then fills them
              // as null and the hard constraints quietly stop existing, with
              // no error anywhere — which is exactly how "priority" went
              // missing once before.
              content: `${SYSTEM_PROMPT}

${JSON_SHAPE}`,
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
    return parseIntent(JSON.parse(content));
  }
}
