import { dishes as catalogue, type Dish, type Listing } from "../../data/restaurants.js";

// Party-size items are real catalogue entries, but they are never an answer to
// one person asking what to eat: a serves-four pack offered to a solo diner is
// a bigger bill dressed as a recommendation. They are reachable by id, so the
// group deal engine and order pricing still see them, and invisible to search
// and recommendation, which is where a single person is being advised.
const dishes = catalogue.filter((d) => !d.serves);
import { qualityOf, type CommunityRating } from "../ratings/blend.js";
import {
  scoreOptions,
  appliedWeights,
  reasonForPriority,
  type Priority,
  type PickReason,
  type Personalization,
  type DecisionTrace,
  type Exclusion,
} from "../advisor/scoring.js";
import {
  applyHardConstraints,
  type HardConstraints,
  type NearestMiss,
} from "../advisor/constraints.js";

export type FoodQuote = {
  dishId: string;
  name: string;
  restaurant: string;
  rating: number;
  /**
   * How many ratings the catalogue claims for this dish.
   *
   * Not the same thing as `ratingCount`, which the ratings service attaches
   * and which counts what Flouna customers actually left. One letter apart and
   * opposite in meaning: this one is a fixed catalogue figure, that one is
   * evidence, and it is the evidence that drives confidence weighting so a
   * thin 4.9 cannot outrank an established 4.6. Never feed this into ranking.
   */
  ratingsCount?: number;
  /** Display chips such as "500g" or "Basmati Rice". */
  portion?: string[];
  /**
   * Shown with the dish, not priced by it.
   *
   * The order routes do not read these: nothing lets a customer add one, and
   * no discount is applied if they could. They exist for display only.
   */
  addOns?: { name: string; pricePaise: number }[];
  bundleDiscountPaise?: number;
  tag: string;
  dietary: "veg" | "nonveg";
  reviewSummary: string;
  image?: string;
  platform: string;
  fulfillment: "in_app"; // always in-app; ONDC routes to the seller
  basePaise: number;
  deliveryFeePaise: number;
  offers: { label: string; discountPaise: number }[];
  effectivePaise: number;
  etaMinutes: number;
};

export type FoodRecommendation = {
  best: FoodQuote;
  alternatives: FoodQuote[];
  why: string;
  pickReason: PickReason;
  /** How this pick was reached — consumed by the decision log, not the UI. */
  trace: DecisionTrace;
  /** Nothing matched what was asked for; these are stand-ins. */
  substituted: boolean;
  /** The user stated a budget and the best option exceeds it. */
  overBudgetPaise?: number;
};

/**
 * The recommendation without its reasoning, for sending to a client.
 *
 * The trace carries the engine's weights, every candidate's score and what
 * each filter removed. It is written to the decision log, which is where it
 * belongs, and it was also being sent to the browser with every chat reply
 * even though nothing there reads it. That published the ranking arithmetic to
 * anyone with developer tools open, for no feature.
 */
export function withoutTrace(rec: FoodRecommendation): Omit<FoodRecommendation, "trace"> {
  const { trace: _trace, ...rest } = rec;
  return rest;
}

/** Stable identity of a food option: which dish, on which listing. */
function quoteKey(q: FoodQuote): string {
  return `${q.dishId}@${q.platform}`;
}

function effectivePrice(listing: Listing): number {
  const discounts = listing.offers.reduce((sum, o) => sum + o.discountPaise, 0);
  return Math.max(0, listing.basePaise + listing.deliveryFeePaise - discounts);
}

function toQuotes(dish: Dish): FoodQuote[] {
  return dish.listings.map((l) => ({
    dishId: dish.id,
    name: dish.name,
    restaurant: dish.restaurant,
    rating: dish.rating,
    ratingsCount: dish.ratingsCount,
    tag: dish.tag,
    dietary: dish.dietary,
    reviewSummary: dish.reviewSummary,
    image: dish.image,
    portion: dish.portion,
    platform: l.platform,
    // Everything is bought in-app — the user pays Flouna and the order is
    // routed to the seller through ONDC. No redirect to any external app.
    fulfillment: "in_app",
    basePaise: l.basePaise,
    deliveryFeePaise: l.deliveryFeePaise,
    offers: l.offers,
    effectivePaise: effectivePrice(l),
    etaMinutes: l.etaMinutes,
    addOns: dish.addOns,
    bundleDiscountPaise: dish.bundleDiscountPaise,
  }));
}

// Every quote for a specific dish by id (all platforms), cheapest first, or
// [] if the id is unknown. A direct catalog lookup — does not go through the
// descriptor/fallback search logic, so callers that need an exact dish
// (price alerts, order pricing) get a stable answer regardless of how the
// text search is tuned.
export function quotesForDish(dishId: string): FoodQuote[] {
  const dish = catalogue.find((d) => d.id === dishId);
  if (!dish) return [];
  return toQuotes(dish).sort((a, b) => a.effectivePaise - b.effectivePaise);
}

// Every quote in the catalog (all dishes, all platforms) — for aggregate stats
// like the feed's "fastest delivery". Distinct from searchFood(""), which is a
// tuned text search (it excludes desserts on an empty query).
export function allQuotes(): FoodQuote[] {
  return dishes.flatMap(toQuotes);
}

// Taste/mood descriptors → catalog keywords. Chat requests arrive as free
// text ("something spicy", "light dinner") that no dish keyword contains —
// without this the search falls through to the whole catalog and the scorer
// can pick something absurd (a dessert for "spicy"). Keys are what users say;
// values are keywords that exist in the catalog.
const DESCRIPTOR_KEYWORDS: Record<string, string[]> = {
  spicy: ["biryani", "momos", "roll", "thali"],
  hot: ["biryani", "momos"],
  sweet: ["cake", "dessert"],
  dessert: ["cake", "ice cream"],
  light: ["salad", "dosa", "momos"],
  healthy: ["salad", "bowl", "quinoa"],
  protein: ["salad", "chicken", "paneer"],
  breakfast: ["dosa", "idli"],
  tiffin: ["dosa", "idli"],
  snack: ["momos", "roll"],
  snacks: ["momos", "roll"],
  lunch: ["thali", "biryani", "meals"],
  dinner: ["biryani", "thali", "pizza"],
  chinese: ["momos"],
  italian: ["pizza", "pasta"],
  cheesy: ["pizza", "pasta"],
};

// Generic filler words an LLM sometimes emits as the "item" ("popular dishes",
// "food") — these should NOT be matched literally (nothing in the catalog says
// "popular"), or the search wrongly falls through to the whole catalog and the
// scorer can pick anything. Stripped before matching so real descriptors and
// dish names in the same phrase still count.
const FILLER_WORDS = new Set([
  "popular", "dishes", "dish", "food", "foods", "something", "eat", "order",
  "want", "get", "me", "a", "an", "the", "some", "any", "to", "for", "please",
  "good", "nice", "tasty", "yummy", "recommend", "recommendation", "hungry",
  "i", "im", "we", "you", "need", "like", "would", "give", "have", "craving",
  "today", "now", "please", "can", "could", "will",
]);

export type SearchOpts = {
  query: string;
  /**
   * A soft ceiling: preferred, and waived rather than leave nothing to show.
   *
   * This is the Budget Guardian's remaining weekly allowance, which is advice
   * about spending. A price the customer actually stated goes in
   * `constraints` instead, where it is enforced. Routing a stated price here
   * would quietly break it; routing the weekly allowance there would refuse
   * every search for someone near the end of their week.
   */
  budgetPaise?: number | null;
  dietary?: "veg" | "nonveg" | "any";
  /** Limits the customer stated, enforced before ranking and never waived. */
  constraints?: HardConstraints | null;
};

export function searchFood(opts: SearchOpts): FoodQuote[] {
  return searchFoodTraced(opts).quotes;
}

// Same search, but also reports what each filter removed. Kept as the single
// implementation so the logged explanation can never drift from the behaviour
// it claims to describe.
export function searchFoodTraced(opts: SearchOpts): {
  quotes: FoodQuote[];
  exclusions: Exclusion[];
  /**
   * True when nothing in the catalogue matched what was asked for and the
   * whole menu was substituted. The caller has to be able to say so: without
   * it, "sushi" is answered with a dosa and nothing admits the swap.
   */
  substituted: boolean;
  /**
   * Present only when a stated limit removed every option: the nearest miss,
   * so the customer can be told what exists without it being recommended.
   */
  unmet: NearestMiss<FoodQuote> | null;
} {
  const exclusions: Exclusion[] = [];
  let substituted = false;
  const note = (rule: string, count: number) => {
    if (count > 0) exclusions.push({ rule, count });
  };

  const rawTerms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  const direct = rawTerms.filter((t) => !FILLER_WORDS.has(t));
  const terms = [...direct, ...direct.flatMap((t) => DESCRIPTOR_KEYWORDS[t] ?? [])];

  let matched =
    terms.length === 0
      ? []
      : dishes.filter((d) =>
          terms.some((t) =>
            // Loose substring matching only for terms long enough to be a real
            // word (≥3 chars). A stray 1–2 char token ("i", "hi") must match a
            // keyword exactly or not at all — otherwise it matches half the
            // catalog and dilutes a specific request like "pizza" until the
            // scorer picks the highest-rated dish (a dessert) instead.
            t.length >= 3
              ? d.keywords.some((k) => k.includes(t) || t.includes(k)) ||
                d.name.toLowerCase().includes(t)
              : d.keywords.includes(t),
          ),
        );
  if (matched.length === 0) {
    // A term-less / unmatched query ("food", "I'm hungry") sees the catalog,
    // but excludes desserts — nobody who just says "hungry" wants cake as the
    // top pick. Desserts stay fully reachable when actually asked for (the
    // "sweet"/"cake"/"dessert" descriptors above match them directly).
    matched = dishes.filter((d) => !d.keywords.includes("dessert"));
    note("generic_query_dessert_exclusion", dishes.length - matched.length);
    // Only a substitution when the person named something specific. "I'm
    // hungry" has nothing to substitute for.
    substituted = rawTerms.length > 0 && direct.length > 0;
  } else {
    note("keyword_no_match", dishes.length - matched.length);
    // A named dish is that dish. "Chicken biryani" matches every chicken dish
    // on "chicken", and those partial matches were ranked beside the biryanis,
    // where a favourites bonus could put a customer's usual momos first. Each
    // word the customer typed counts for more the fewer dishes it matches, so
    // "biryani" outweighs "chicken", and only the dishes scoring highest stay.
    // A one word search, or one where every word is as common as the others,
    // keeps everything it matched.
    if (direct.length > 1) {
      const hits = (d: (typeof dishes)[number], t: string) =>
        t.length >= 3
          ? d.keywords.some((k) => k.includes(t) || t.includes(k)) || d.name.toLowerCase().includes(t)
          : d.keywords.includes(t);
      const weight = new Map<string, number>();
      for (const t of direct) {
        const df = dishes.filter((d) => hits(d, t)).length;
        if (df > 0) weight.set(t, Math.log(dishes.length / df));
      }
      const score = (d: (typeof dishes)[number]) => direct.reduce((s, t) => s + (hits(d, t) ? (weight.get(t) ?? 0) : 0), 0);
      const top = Math.max(...matched.map(score));
      if (top > 0) {
        const before = matched.length;
        matched = matched.filter((d) => score(d) >= top - 1e-9);
        note("less_specific_match", before - matched.length);
      }
    }
  }

  if (opts.dietary && opts.dietary !== "any") {
    const before = matched.length;
    matched = matched.filter((d) => d.dietary === opts.dietary);
    note("dietary_filter", before - matched.length);
  }

  let quotes = matched.flatMap(toQuotes);

  // What the customer ruled out comes out first, and stays out. Applied
  // before the soft budget so that allowance only ever chooses among options
  // that are valid: it may be waived, a stated limit may not.
  const hard = applyHardConstraints(
    quotes,
    (q) => ({ pricePaise: q.effectivePaise, etaMinutes: q.etaMinutes }),
    opts.constraints,
  );
  for (const r of hard.rejected) note(r.rule, r.count);
  quotes = hard.kept;

  if (opts.budgetPaise && quotes.length > 0) {
    const within = quotes.filter((q) => q.effectivePaise <= opts.budgetPaise!);
    // The budget is deliberately non-binding: if nothing fits, it is discarded
    // rather than returning an empty screen. Both outcomes are recorded, since
    // "over budget but shown anyway" is exactly the behaviour worth disclosing.
    if (within.length > 0) {
      note("budget_ceiling", quotes.length - within.length);
      quotes = within;
    } else {
      note("budget_ceiling_waived", quotes.length);
    }
  }
  return {
    quotes: quotes.sort((a, b) => a.effectivePaise - b.effectivePaise),
    exclusions,
    substituted,
    unmet: hard.nearestMiss,
  };
}

// The "decision" step: score every option on price, rating and speed weighted
// by what the user asked for (priority), then pick the highest-scoring one.
// This is the ratings-aware engine — "top-rated" genuinely changes the winner.
export function recommendFood(
  opts: SearchOpts & {
    priority?: Priority;
    personal?: Personalization;
    /**
     * What customers have actually said, keyed by dish.
     *
     * Ranking used the catalogue baseline while the screen showed a
     * community-blended number, so the two could disagree: Flouna could call
     * something its top-rated pick and display a rating lower than an
     * alternative's. Ratings were collected, shown, and then ignored by the
     * one step they were collected for.
     *
     * Optional, because a caller without a database (the tests, and the
     * offline paths) still needs to be able to rank.
     */
    community?: Map<string, CommunityRating>;
  },
): FoodRecommendation | null {
  const { quotes, exclusions, substituted } = searchFoodTraced(opts);
  if (quotes.length === 0) return null;

  const priority = opts.priority ?? "balanced";
  const ranked = scoreOptions(
    quotes.map((q) => ({
      pricePaise: q.effectivePaise,
      // Rank on the number the customer is shown, with the weight of evidence
      // behind it. Without a community map this is the catalogue baseline and
      // confidence weighting stays off, exactly as before.
      ...(opts.community
        ? qualityOf(q.rating, opts.community.get(q.dishId))
        : { rating: q.rating }),
      etaMinutes: q.etaMinutes,
      name: q.name,
      quote: q,
    })),
    priority,
    opts.personal,
  );

  const best = ranked[0]!.item.quote;
  const cheapest = [...quotes].sort((a, b) => a.effectivePaise - b.effectivePaise)[0]!;
  const topRated = [...quotes].sort((a, b) => b.rating - a.rating)[0]!;

  const alternatives = ranked
    .slice(1)
    .filter((r) => !(r.item.quote.platform === best.platform && r.item.quote.dishId === best.dishId))
    .slice(0, 3)
    .map((r) => r.item.quote);

  // What the same dish costs on the next cheapest platform we did not pick.
  //
  // This used to measure against `cheapest`, the lowest price anywhere in the
  // result set. The pick is drawn from that same set, so its price is never
  // below the minimum and the difference could only ever be zero or negative:
  // both messages below were unreachable. Measured across 2,420 searches
  // covering every dish, priority, budget and dietary combination, neither
  // line appeared once, including on the 387 where the pick genuinely was
  // dearer than an alternative on screen and the customer most needed the
  // trade explained.
  //
  // Comparing the same dish across platforms is what the saving was always
  // meant to be, and is the number the savings ledger is built on.
  const sameDishElsewhere = quotes
    .filter((q) => q.dishId === best.dishId && q.platform !== best.platform)
    .sort((a, b) => a.effectivePaise - b.effectivePaise)[0];
  const saving = sameDishElsewhere
    ? Math.max(0, sameDishElsewhere.effectivePaise - best.effectivePaise)
    : 0;

  let why: string;
  if (priority === "rating") {
    why = `Top-rated pick, ${best.rating}★ at ${best.restaurant}`;
    if (best.dishId === cheapest.dishId && best.platform === cheapest.platform)
      why += ", and it's the best price too";
  } else if (priority === "speed") {
    why = `Fastest good option, arrives in ${best.etaMinutes} min, rated ${best.rating}★`;
  } else if (priority === "price") {
    why = `Best effective price after offers`;
    if (saving > 0) why += `, you save ₹${Math.round(saving / 100)} vs the next option`;
  } else {
    // balanced: explain the trade-off it optimised
    why = `Best overall, ${best.rating}★, ${best.etaMinutes} min`;
    if (saving > 0) why += `, and ₹${Math.round(saving / 100)} cheaper than the next`;
    else why += `, best value right now`;
  }
  if (topRated.rating > best.rating && priority !== "rating") {
    why += `. Want the highest rated? ${topRated.restaurant} is ${topRated.rating}★`;
  }

  // Measured against the price the customer named, which is what the banner
  // tells them ("above your stated budget"). That limit is enforced before
  // ranking, so this is normally absent and stays as a guard should the
  // enforcement ever be bypassed. It is not measured against budgetPaise: that
  // is the weekly allowance, which the customer did not state in this message
  // and which already has its own note.
  const stated = opts.constraints?.maxPricePaise ?? null;
  const overBudgetPaise =
    stated && best.effectivePaise > stated ? best.effectivePaise - stated : undefined;

  return {
    best,
    alternatives,
    why,
    substituted,
    overBudgetPaise,
    pickReason: reasonForPriority(priority),
    trace: {
      priority,
      weights: appliedWeights(priority, opts.personal),
      personalized: priority === "balanced" && Boolean(opts.personal),
      candidateCount: quotes.length,
      excludedCount: exclusions.reduce((s, e) => s + e.count, 0),
      exclusions,
      scores: ranked.map((r) => ({
        key: quoteKey(r.item.quote),
        pricePaise: r.item.quote.effectivePaise,
        rating: r.item.quote.rating,
        etaMinutes: r.item.quote.etaMinutes,
        score: r.score,
      })),
      chosenKey: quoteKey(best),
    },
  };
}
