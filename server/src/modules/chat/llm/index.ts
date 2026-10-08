import { env } from "../../../config/env.js";
import type { LlmProvider } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { DeepseekProvider } from "./deepseek.js";
import { SelfHostedProvider } from "./selfHosted.js";
import { NvidiaProvider } from "./nvidia.js";
import { OllamaProvider } from "./ollama.js";
import { DemoProvider } from "./demo.js";
import { FallbackProvider } from "./fallback.js";

// Provider selection is config-only — swapping LLMs never touches business logic.
//
// LLM_PROVIDER names the preferred provider; every other provider that has a
// key becomes a fallback behind it. One vendor rate-limiting or going down then
// costs a retry rather than the whole AI experience, which is what happened
// when an expired Anthropic key silently sent every request to the rule-based
// engine.

/**
 * Whether Ollama belongs in the fallback chain. A model name alone means "the
 * Ollama on this machine", which is right in development and nowhere in
 * production: Railway has no localhost model, so every chat would wait out a
 * failed call before falling back.
 */
export function ollamaConfigured(e: {
  OLLAMA_URL?: string;
  OLLAMA_MODEL?: string;
  NODE_ENV: string;
}): boolean {
  return Boolean(e.OLLAMA_URL || (e.NODE_ENV !== "production" && e.OLLAMA_MODEL));
}

export type ProviderName = "anthropic" | "google" | "deepseek" | "nvidia" | "ollama" | "self_hosted";

const BUILDERS: Record<ProviderName, { hasKey: () => boolean; make: () => LlmProvider }> = {
  anthropic: { hasKey: () => Boolean(env.ANTHROPIC_API_KEY), make: () => new AnthropicProvider() },
  google: { hasKey: () => Boolean(env.GOOGLE_AI_API_KEY), make: () => new GoogleProvider() },
  deepseek: { hasKey: () => Boolean(env.DEEPSEEK_API_KEY), make: () => new DeepseekProvider() },
  nvidia: { hasKey: () => Boolean(env.NVIDIA_API_KEY), make: () => new NvidiaProvider() },
  // A model name alone means "the Ollama on this machine", which is right in
  // development and nowhere in production: Railway has no localhost model, so
  // every chat would wait out a failed call before falling back.
  ollama: { hasKey: () => ollamaConfigured(env), make: () => new OllamaProvider() },
  // Ours. "Has a key" means "is actually running somewhere": without a URL
  // there is nothing to call, and including it anyway would put a guaranteed
  // timeout in front of every request the chain makes.
  self_hosted: {
    hasKey: () => Boolean(env.SELF_HOSTED_LLM_URL),
    make: () => new SelfHostedProvider(),
  },
};

/**
 * The providers that may answer customers, in the order they are tried:
 * the preferred one first, then every other configured one.
 *
 * The watcher is left out. A model under evaluation would otherwise join this
 * chain the moment its URL is set, and answer customers whenever the
 * preferred provider failed, before anyone had measured it.
 */
export function providerOrder(
  preferred: ProviderName,
  configured: (name: ProviderName) => boolean,
  watcherName?: string,
): ProviderName[] {
  return [
    preferred,
    ...(Object.keys(BUILDERS) as ProviderName[]).filter((n) => n !== preferred),
  ].filter((n) => n !== watcherName && configured(n));
}

/** Preferred provider first, then every other configured one, then demo. */
function buildProvider(): LlmProvider {
  const preferred = env.LLM_PROVIDER;
  if (preferred === "demo") return new DemoProvider();

  const usable = providerOrder(preferred, (n) => BUILDERS[n].hasKey(), env.LLM_WATCHER);

  if (usable.length === 0) {
    console.warn(`[llm] LLM_PROVIDER=${preferred} but no provider has a key, using demo mode`);
    return new DemoProvider();
  }
  if (!usable.includes(preferred)) {
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

/** The model being measured beside the one that answers, when one is set up. */
export const watcherProvider: LlmProvider | null =
  env.LLM_WATCHER && BUILDERS[env.LLM_WATCHER].hasKey() ? BUILDERS[env.LLM_WATCHER].make() : null;
if (env.LLM_WATCHER && !watcherProvider) {
  console.warn(`[llm] LLM_WATCHER=${env.LLM_WATCHER} is not configured, so nothing is being watched`);
}
export const demoFallback = new DemoProvider();
