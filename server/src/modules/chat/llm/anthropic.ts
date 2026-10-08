import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../../config/env.js";
import { parseIntent, type Intent, type LlmProvider } from "./types.js";
import { JSON_SCHEMA, SYSTEM_PROMPT } from "./prompt.js";

export class AnthropicProvider implements LlmProvider {
  name = "anthropic";
  // Without a bound, a hung upstream call blocks here indefinitely and never
  // rejects — which means FallbackProvider never sees a failure to fall
  // through on, and the whole point of chaining providers is defeated by the
  // first one going quiet instead of erroring.
  //
  // One attempt and no retries of its own: the SDK retried twice by default,
  // so a hung call held the reply for about a minute before the chain even
  // started. The fallback chain is the retry.
  private client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: env.LLM_TIMEOUT_MS,
    maxRetries: 0,
  });

  async extractIntent(userMessage: string): Promise<Intent> {
    const response = await this.client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: JSON_SCHEMA },
      },
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new Error("LLM returned no text content");
    }
    // Validate against our schema even though the API enforces shape —
    // belt and suspenders before anything reaches business logic.
    return parseIntent(JSON.parse(text.text));
  }
}
