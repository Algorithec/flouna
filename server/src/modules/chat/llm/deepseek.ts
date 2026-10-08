import { env } from "../../../config/env.js";
import { parseIntent, type Intent, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT, JSON_SHAPE } from "./prompt.js";

// DeepSeek exposes an OpenAI-compatible chat API with JSON mode.
export class DeepseekProvider implements LlmProvider {
  name = "deepseek";

  async extractIntent(userMessage: string): Promise<Intent> {
    // fetch() never times out on its own — without this, a hung DeepSeek
    // connection blocks here forever instead of rejecting, which means
    // FallbackProvider never gets a failure to fall through on.
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        response_format: { type: "json_object" },
        max_tokens: 512,
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}\n\n${JSON_SHAPE}`,
          },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`DeepSeek request failed (${res.status})`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned no content");
    return parseIntent(JSON.parse(content));
  }
}
