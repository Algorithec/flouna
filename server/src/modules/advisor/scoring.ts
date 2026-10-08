// The decision engine's scoring core. Flouna does not pick "cheapest, period" —
// it scores each option on price, rating and speed, weighted by what the user
// actually asked for. "top-rated" raises the rating weight, "cheap" raises
// price, "fast" raises speed. This is what makes the recommendation the
// *smartest* choice, not just the lowest number — and it stays deterministic
// and tamper-proof (the AI only chooses the priority; the math is ours).

export type Priority = "price" | "rating" | "speed" | "balanced";

// The basis on which the winning option was chosen — drives the UI badge.
export type PickReason = "top_rated" | "best_price" | "fastest" | "best_overall";

export function reasonForPriority(priority: Priority): PickReason {
  switch (priority) {
    case "rating":
      return "top_rated";
    case "price":
      return "best_price";
    case "speed":
      return "fastest";
    default:
      return "best_overall";
  }
}

export type Weights = { price: number; rating: number; speed: number };

/** Why results were dropped before scoring. Reported by each domain's search. */
export type Exclusion = { rule: string; count: number };

/**
 * An auditable account of one ranking decision: what was excluded and why,
 * which weights were applied, and what every surviving option scored.
 * Shared by food and rides so a decision log entry means the same thing in
 * both domains.
 */
export type DecisionTrace = {
  priority: Priority;
  weights: Weights;
  personalized: boolean;
  candidateCount: number;
  excludedCount: number;
  exclusions: Exclusion[];
  scores: {
    key: string;
    pricePaise: number;
    rating: number;
    etaMinutes: number;
    score: number;
  }[];
  chosenKey: string;
};

// Weight presets per priority. They always sum to 1 so scores stay comparable.
const WEIGHTS: Record<Priority, Weights> = {
  price: { price: 0.7, rating: 0.2, speed: 0.1 },
  rating: { price: 0.2, rating: 0.65, speed: 0.15 },
  speed: { price: 0.25, rating: 0.2, speed: 0.55 },
  balanced: { price: 0.45, rating: 0.35, speed: 0.2 },
};

export function weightsFor(priority: Priority): Weights {
  return WEIGHTS[priority] ?? WEIGHTS.balanced;
}

// Normalise a value to 0..1 where 1 is best. For price and ETA, lower is better
// (inverted); for rating, higher is better.
function normLowerBetter(value: number, min: number, max: number): number {
  if (max <= min) return 1;
  return 1 - (value - min) / (max - min);
}
function normHigherBetter(value: number, min: number, max: number): number {
  if (max <= min) return 1;
  return (value - min) / (max - min);
}

export type Scorable = {
  pricePaise: number;
  rating: number; // 0..5
  /**
   * How many ratings that average is built from.
   *
   * Optional because not every source knows it. Where it is known, the ranker
   * stops treating a 4.9 from two people as the equal of a 4.6 from four
   * thousand: see `discountByUncertainty`.
   */
  ratingCount?: number;
  etaMinutes: number;
  name?: string; // optional, for taste/habit matching
};

// Ratings an option needs before its own average carries most of the weight.
// Matches CONFIDENCE_AT in the ratings service, which shrinks the number that
// gets displayed toward the catalogue baseline by the same measure.
const RATING_CONFIDENCE_AT = 10;
// Roughly the spread of star ratings on a 0..5 scale. Sizes the uncertainty
// below, so it wants to be about right rather than exact.
const RATING_SPREAD = 0.8;

/**
 * Discounts a rating by how little is known about it.
 *
 * The shrinking has already happened by the time a rating reaches here: the
 * ratings service blends community stars toward the catalogue baseline in
 * proportion to how many people rated, which is a proper prior and a stable
 * one. What was missing at the ranking boundary is the count, so two options
 * both showing 4.6 ranked identically whether that came from eleven people or
 * four thousand. Ranking is where it matters most, because it decides who gets
 * steered where.
 *
 * So the only thing to add here is uncertainty. Two ratings averaging 4.9
 * could really be anything; four thousand averaging 4.6 could not. Subtracting
 * an error that falls away as evidence accumulates is what makes "we are
 * confident this is good" beat "this might be excellent", while still letting
 * a genuinely better option win once enough people agree.
 *
 * An earlier version shrank a second time toward the set's own mean. That was
 * wrong in a way worth recording: with one heavily rated option in the set,
 * the prior became that option, everything collapsed onto it, and whichever
 * had the most ratings won regardless of whether they were good or bad.
 *
 * All or nothing: if any option has no count, none are adjusted. Penalising
 * only the options whose counts we know would advantage the ones we know least
 * about, which is the opposite of the intent.
 */
function discountByUncertainty<T extends Scorable>(items: T[]): number[] {
  const counts: number[] = [];
  for (const item of items) {
    if (item.ratingCount === undefined || item.ratingCount < 0) {
      return items.map((i) => i.rating);
    }
    counts.push(item.ratingCount);
  }

  return items.map((item, idx) => {
    const evidence = counts[idx]! + RATING_CONFIDENCE_AT;
    return item.rating - RATING_SPREAD / Math.sqrt(evidence);
  });
}

// Personalization signals derived from the user's DecisionProfile. These only
// adjust WEIGHTS and add a small taste BONUS — they never touch prices, so the
// engine stays deterministic and tamper-proof.
export type Personalization = {
  spendBand?: "budget" | "mid" | "premium" | "unknown";
  // Returns a small bonus (0..1, capped on apply) for an option matching the
  // user's taste/habits (e.g. a dish they reorder). Additive to the score only.
  tasteBonus?: (item: Scorable) => number;
};

// When the user didn't state a preference (balanced), their spend band nudges
// the weights: budget spenders lean to price, premium spenders to rating.
function personalizeWeights(base: Weights, p?: Personalization): Weights {
  if (!p || !p.spendBand || p.spendBand === "unknown" || p.spendBand === "mid")
    return base;
  if (p.spendBand === "budget")
    return normalizeWeights({ price: base.price + 0.15, rating: base.rating, speed: base.speed });
  // premium
  return normalizeWeights({ price: base.price, rating: base.rating + 0.15, speed: base.speed });
}

function normalizeWeights(w: Weights): Weights {
  const sum = w.price + w.rating + w.speed || 1;
  return { price: w.price / sum, rating: w.rating / sum, speed: w.speed / sum };
}

// Scores a list of options (0..100) and returns them sorted best-first, with
// the score attached. Pure ranking — callers map their own quote shape in.
// Optional `personal` applies the user's profile (only meaningful for the
// balanced priority; an explicit "cheapest" still dominates).
// The weights a given search will actually be scored with, after any profile
// adjustment. Exported so a decision can be logged with the same numbers the
// scorer used, rather than a re-derived guess at them.
export function appliedWeights(
  priority: Priority,
  personal?: Personalization,
): Weights {
  // Profile only adjusts the *unstated* preference; explicit priority wins.
  return priority === "balanced"
    ? personalizeWeights(weightsFor(priority), personal)
    : weightsFor(priority);
}

export function scoreOptions<T extends Scorable>(
  items: T[],
  priority: Priority,
  personal?: Personalization,
): { item: T; score: number }[] {
  if (items.length === 0) return [];
  const w = appliedWeights(priority, personal);

  const prices = items.map((i) => i.pricePaise);
  // Confidence-adjusted, so a thin average cannot outrank an established one.
  const ratings = discountByUncertainty(items);
  const etas = items.map((i) => i.etaMinutes);
  const pMin = Math.min(...prices),
    pMax = Math.max(...prices);
  const rMin = Math.min(...ratings),
    rMax = Math.max(...ratings);
  const eMin = Math.min(...etas),
    eMax = Math.max(...etas);

  return items
    .map((item, idx) => {
      const priceScore = normLowerBetter(item.pricePaise, pMin, pMax);
      const ratingScore = normHigherBetter(ratings[idx]!, rMin, rMax);
      const speedScore = normLowerBetter(item.etaMinutes, eMin, eMax);
      let score =
        priceScore * w.price + ratingScore * w.rating + speedScore * w.speed;
      // Taste/habit match: a small additive nudge, capped so it tips ties but
      // never overrides a clearly better option.
      if (personal?.tasteBonus) {
        score += Math.min(0.12, Math.max(0, personal.tasteBonus(item)));
      }
      return { item, score: Math.round(score * 100) };
    })
    .sort((a, b) => b.score - a.score);
}
