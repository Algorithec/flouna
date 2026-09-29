import { env } from "../../../config/env.js";
import type { LlmProvider } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { DeepseekProvider } from "./deepseek.js";
import { NvidiaProvider } from "./nvidia.js";
import { DemoProvider } from "./demo.js";
import { FallbackProvider } from "./fallback.js";

// Provider selection is config-only — swapping LLMs never touches business logic.
//
// LLM_PROVIDER names the preferred provider; every other provider that has a
// key becomes a fallback behind it. One vendor rate-limiting or going down then
// costs a retry rather than the whole AI experience, which is what happened
// when an expired Anthropic key silently sent every request to the rule-based
// engine.

type ProviderName = "anthropic" | "google" | "deepseek" | "nvidia";

const BUILDERS: Record<ProviderName, { hasKey: () => boolean; make: () => LlmProvider }> = {
  anthropic: { hasKey: () => Boolean(env.ANTHROPIC_API_KEY), make: () => new AnthropicProvider() },
  google: { hasKey: () => Boolean(env.GOOGLE_AI_API_KEY), make: () => new GoogleProvider() },
  deepseek: { hasKey: () => Boolean(env.DEEPSEEK_API_KEY), make: () => new DeepseekProvider() },
  nvidia: { hasKey: () => Boolean(env.NVIDIA_API_KEY), make: () => new NvidiaProvider() },
};

/** Preferred provider first, then every other configured one, then demo. */
function buildProvider(): LlmProvider {
  const preferred = env.LLM_PROVIDER;
  if (preferred === "demo") return new DemoProvider();

  const order: ProviderName[] = [
    preferred,
    ...(Object.keys(BUILDERS) as ProviderName[]).filter((n) => n !== preferred),
  ];

  const usable = order.filter((n) => BUILDERS[n].hasKey());

  if (usable.length === 0) {
    console.warn(`[llm] LLM_PROVIDER=${preferred} but no provider has a key, using demo mode`);
    return new DemoProvider();
  }
  if (!BUILDERS[preferred].hasKey()) {
    console.warn(
      `[llm] LLM_PROVIDER=${preferred} has no key, leading with ${usable[0]} instead`,
    );
  }

  const chain = usable.map((n) => BUILDERS[n].make());
  if (chain.length === 1) return chain[0]!;

  console.log(`[llm] provider chain: ${usable.join(" -> ")}`);
  return new FallbackProvider(chain);
}

export const llm: LlmProvider = buildProvider();
export const demoFallback = new DemoProvider();
