import { products, type Product, type ProductListing } from "../../data/products.js";
import {
  scoreOptions,
  reasonForPriority,
  type Priority,
  type PickReason,
  type Personalization,
} from "../advisor/scoring.js";

export type ProductQuote = {
  productId: string;
  name: string;
  brand: string;
  category: string;
  rating: number;
  reviews: number;
  tag: string;
  reviewSummary: string;
  platform: string;
  basePaise: number;
  offers: { label: string; discountPaise: number }[];
  effectivePaise: number;
  deliveryDays: number;
  inStock: boolean;
};

/**
 * Each fragment the reason for a product pick is built from, as a code the app
 * translates (`why.s.<code>`). The fragments carry their own leading
 * punctuation, so the app joins them as they come.
 */
export const SHOP_WHY_CODES = [
  "topRated",
  "fastestDay",
  "fastestDays",
  "lowestPrice",
  "saveVsNext",
  "bestOverall",
  "cheaperThanNext",
  "bestValue",
  "higherRated",
  "soonerDay",
  "soonerDays",
] as const;
export type ShopWhyPart = { code: (typeof SHOP_WHY_CODES)[number]; params?: Record<string, string> };

export type ProductRecommendation = {
  best: ProductQuote;
  alternatives: ProductQuote[];
  why: string;
  /** `why`, fragment by fragment, for the reader's language. */
  whyParts: ShopWhyPart[];
  pickReason: PickReason;
};

function effectivePrice(listing: ProductListing): number {
  const discounts = listing.offers.reduce((sum, o) => sum + o.discountPaise, 0);
  return Math.max(0, listing.basePaise - discounts);
}

function toQuotes(product: Product): ProductQuote[] {
  return product.listings.map((l) => ({
    productId: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    rating: product.rating,
    reviews: product.reviews,
    tag: product.tag,
    reviewSummary: product.reviewSummary,
    platform: l.platform,
    basePaise: l.basePaise,
    offers: l.offers,
    effectivePaise: effectivePrice(l),
    deliveryDays: l.deliveryDays,
    inStock: l.inStock,
  }));
}

export function quotesForProduct(productId: string): ProductQuote[] {
  const product = products.find((p) => p.id === productId);
  if (!product) return [];
  return toQuotes(product).sort((a, b) => a.effectivePaise - b.effectivePaise);
}

type ProductSearch = {
  query: string;
  budgetPaise?: number | null;
  category?: string | null;
};

export function searchProducts(opts: ProductSearch): ProductQuote[] {
  return searchProductsTraced(opts).quotes;
}

/**
 * The same search, also saying when nothing matched and the whole range was
 * shown instead, so the screen can say so rather than list it as results.
 */
export function searchProductsTraced(opts: ProductSearch): {
  quotes: ProductQuote[];
  substituted: boolean;
} {
  const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);

  let matched = products.filter((p) =>
    terms.some(
      (t) =>
        p.keywords.some((k) => k.includes(t) || t.includes(k)) ||
        p.name.toLowerCase().includes(t) ||
        p.brand.toLowerCase().includes(t),
    ),
  );
  const substituted = matched.length === 0 && terms.length > 0;
  if (matched.length === 0) matched = products; // generic browse

  if (opts.category) {
    matched = matched.filter((p) => p.category === opts.category);
  }

  let quotes = matched.flatMap(toQuotes).filter((q) => q.inStock);
  if (opts.budgetPaise) {
    const within = quotes.filter((q) => q.effectivePaise <= opts.budgetPaise!);
    if (within.length > 0) quotes = within;
  }
  return { quotes: quotes.sort((a, b) => a.effectivePaise - b.effectivePaise), substituted };
}

// Decision step: score every option on price, rating and delivery speed,
// weighted by the user's priority — same ratings-aware engine as food and
// rides. "top-rated" genuinely changes the winner here too.
export function recommendProduct(
  opts: Parameters<typeof searchProducts>[0] & {
    priority?: Priority;
    personal?: Personalization;
  },
): ProductRecommendation | null {
  const quotes = searchProducts(opts);
  if (quotes.length === 0) return null;

  const priority = opts.priority ?? "balanced";
  const ranked = scoreOptions(
    quotes.map((q) => ({
      pricePaise: q.effectivePaise,
      rating: q.rating,
      etaMinutes: q.deliveryDays, // delivery days as the "speed" signal
      name: q.name,
      quote: q,
    })),
    priority,
    opts.personal,
  );

  const best = ranked[0]!.item.quote;
  const cheapest = [...quotes].sort((a, b) => a.effectivePaise - b.effectivePaise)[0]!;
  const topRated = [...quotes].sort((a, b) => b.rating - a.rating)[0]!;
  const fastest = [...quotes].sort((a, b) => a.deliveryDays - b.deliveryDays)[0]!;

  const alternatives = ranked
    .slice(1)
    .filter((r) => !(r.item.quote.platform === best.platform && r.item.quote.productId === best.productId))
    .slice(0, 3)
    .map((r) => r.item.quote);

  const saving = Math.max(0, cheapest.effectivePaise - best.effectivePaise);

  // The English and the codes are built together, fragment by fragment, so
  // the translated reason says exactly what the English one does.
  const whyParts: ShopWhyPart[] = [];
  let why = "";
  const say = (english: string, code: ShopWhyPart["code"], params?: Record<string, string>) => {
    why += english;
    whyParts.push(params ? { code, params } : { code });
  };
  const rating = String(best.rating);
  const days = String(best.deliveryDays);
  const rupees = String(Math.round(saving / 100));
  if (priority === "rating") {
    const reviews = best.reviews.toLocaleString("en-IN");
    say(`Top-rated pick, ${rating}★ (${reviews} reviews)`, "topRated", { rating, reviews });
  } else if (priority === "speed") {
    if (best.deliveryDays > 1) say(`Fastest delivery, ${days} days, rated ${rating}★`, "fastestDays", { days, rating });
    else say(`Fastest delivery, ${days} day, rated ${rating}★`, "fastestDay", { days, rating });
  } else if (priority === "price") {
    say("Lowest effective price after offers", "lowestPrice");
    if (saving > 0) say(`, you save ₹${rupees} vs the next option`, "saveVsNext", { rupees });
  } else {
    say(`Best overall, ${rating}★, ${days}-day delivery`, "bestOverall", { rating, days });
    if (saving > 0) say(`, and ₹${rupees} cheaper than the next`, "cheaperThanNext", { rupees });
    else say(", best value across sellers", "bestValue");
  }
  if (topRated.rating > best.rating && priority !== "rating") {
    say(`. Highest rated: ${topRated.brand} at ${topRated.rating}★`, "higherRated", {
      brand: topRated.brand,
      rating: String(topRated.rating),
    });
  } else if (fastest.deliveryDays < best.deliveryDays && priority !== "speed") {
    const sooner = String(fastest.deliveryDays);
    if (fastest.deliveryDays > 1) say(`. Need it sooner? Another seller delivers in ${sooner} days`, "soonerDays", { days: sooner });
    else say(`. Need it sooner? Another seller delivers in ${sooner} day`, "soonerDay", { days: sooner });
  }

  return { best, alternatives, why, whyParts, pickReason: reasonForPriority(priority) };
}
