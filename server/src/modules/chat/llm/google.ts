import { env } from "../../../config/env.js";
import { parseIntent, type Intent, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT, JSON_SHAPE } from "./prompt.js";

// The JSON contract appended to the system prompt — identical shape to the
// other providers so the firewall/intent schema stays the single source of truth.
const JSON_INSTRUCTION = `${SYSTEM_PROMPT}\n\n${JSON_SHAPE}`;

// Google AI Studio (Gemini) via the Generative Language REST API. Free-tier
// friendly — used for the bulk of test traffic in our hybrid LLM setup.
export class GoogleProvider implements LlmProvider {
  name = "google";

  private readonly model = env.GOOGLE_AI_MODEL;

  async extractIntent(userMessage: string): Promise<Intent> {
    // The key goes in a header, not the query string, so it never lands in
    // proxy/access logs, error traces, or crash reports — matching how the
    // Anthropic and DeepSeek adapters pass their credentials.
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    // fetch() never times out on its own — without this, a hung Google AI
    // connection blocks here forever instead of rejecting, which means
    // FallbackProvider never gets a failure to fall through on.
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GOOGLE_AI_API_KEY ?? "",
      },
      body: JSON.stringify({
        // System prompt as a leading user turn (v1beta supports systemInstruction
        // too, but folding it in keeps parity with the other adapters).
        systemInstruction: { parts: [{ text: JSON_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 512,
          temperature: 0.4,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Google AI request failed (${res.status})`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("Google AI returned no content");
    return parseIntent(JSON.parse(content));
  }
}
