import type { Intent, LlmProvider } from "./types.js";

/**
 * Which provider actually served the last request, and how far down the chain
 * it sat. Read straight after extractIntent so the message can be stored with
 * its provenance — the corpus is training data for our own engine later, and a
 * mix of vendors with no labels cannot be separated after the fact.
 */
export type Served = { provider: string; depth: number };

// Tries each provider in turn and returns the first intent one produces.
//
// A single provider is a single point of failure for the whole product: when it
// rate-limits or has an outage, every request drops to the rule-based engine
// and the app quietly stops being an AI product. Chaining means a Claude outage
// is served by DeepSeek, and a DeepSeek outage by Gemini, before anything
// degrades.
//
// Order is deliberate rather than round-robin — the configured provider is
// always tried first, so this changes nothing on the happy path. Failures are
// logged with the provider that failed and the one that took over, because a
// silent switch hides both the outage and the cost moving to another vendor.
/**
 * Consecutive failures before a provider is stood down, and for how long.
 *
 * Without this, a provider that is down is still tried on every request, and
 * every request pays its full timeout before the chain moves on. A self-hosted
 * model is the sharp case: it is allowed thirty seconds because a cold box is
 * worth waiting for, so an unreachable one turns every message into a thirty
 * second wait. The product is not down, it just behaves as if it is.
 *
 * Three strikes rather than one, because a single timeout is ordinary. Half a
 * minute of standing down, because that is long enough to stop paying the
 * timeout on every request and short enough that recovery is not noticed.
 */
const FAILURES_BEFORE_STANDDOWN = 3;
const STANDDOWN_MS = 30_000;

export class FallbackProvider implements LlmProvider {
  readonly name: string;
  /** Consecutive failures and stand-down expiry, per provider in the chain. */
  private readonly health = new Map<number, { failures: number; skipUntil: number }>();

  constructor(private readonly chain: LlmProvider[]) {
    if (chain.length === 0) throw new Error("FallbackProvider needs at least one provider");
    this.name = chain.map((p) => p.name).join(" -> ");
  }

  private standingDown(index: number, now: number): boolean {
    const h = this.health.get(index);
    return h !== undefined && h.skipUntil > now;
  }

  private recordFailure(index: number, name: string, now: number): void {
    const h = this.health.get(index) ?? { failures: 0, skipUntil: 0 };
    h.failures += 1;
    if (h.failures >= FAILURES_BEFORE_STANDDOWN) {
      h.skipUntil = now + STANDDOWN_MS;
      h.failures = 0;
      console.warn(
        `[llm] ${name} failed ${FAILURES_BEFORE_STANDDOWN} times in a row, standing it down for ${STANDDOWN_MS / 1000}s`,
      );
    }
    this.health.set(index, h);
  }

  private recordSuccess(index: number): void {
    // One good answer clears the record. A provider that works is not on
    // probation for something it did earlier.
    this.health.delete(index);
  }

  async extractIntent(userMessage: string): Promise<Intent> {
    return (await this.extractIntentTraced(userMessage)).intent;
  }

  /**
   * Same call, but says who answered. Returned rather than stashed on the
   * instance: concurrent chats share this object, so an instance field would
   * hand one request another request's provenance — silently mislabelling the
   * corpus this exists to keep clean.
   */
  async extractIntentTraced(
    userMessage: string,
  ): Promise<{ intent: Intent; served: Served }> {
    let lastError: unknown;
    const now = Date.now();
    let skippedAll = true;

    for (let i = 0; i < this.chain.length; i++) {
      const provider = this.chain[i]!;
      // Stood down after repeated failures. Skipped without being called, so
      // a dead provider costs nothing instead of its whole timeout.
      if (this.standingDown(i, now)) continue;
      skippedAll = false;
      try {
        const intent = await provider.extractIntent(userMessage);
        this.recordSuccess(i);
        // Only worth saying when it was not the first choice — otherwise this
        // would log on every single request.
        if (i > 0) {
          console.warn(`[llm] served by ${provider.name} after ${i} provider(s) failed`);
        }
        return { intent, served: { provider: provider.name, depth: i } };
      } catch (err) {
        lastError = err;
        this.recordFailure(i, provider.name, now);
        const next = this.chain[i + 1];
        console.error(
          `[llm] ${provider.name} failed: ${err instanceof Error ? err.message : String(err)}` +
            (next ? `, falling back to ${next.name}` : ", no providers left"),
        );
      }
    }

    // Everything was standing down, so nothing was attempted. Throw, and leave
    // the stand-downs exactly as they are: each ends on its own schedule and
    // that provider is tried again then.
    //
    // This used to clear every record before throwing. Review pointed out what
    // that did: a request landing a moment before the stand-downs expired got
    // an error, and the next one then called every provider still believed to
    // be down, which is the storm a circuit breaker exists to prevent. Throwing
    // here is not a customer-facing failure either, since the caller degrades
    // to the rule engine.
    if (skippedAll) {
      throw new Error("every provider is standing down after repeated failures");
    }

    // Every provider failed. Throw rather than invent an intent: the caller
    // already degrades to the rule-based engine, and that decision belongs
    // there, not buried in here.
    throw lastError instanceof Error
      ? lastError
      : new Error("all LLM providers failed");
  }
}
