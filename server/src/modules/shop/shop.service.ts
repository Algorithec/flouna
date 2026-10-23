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

export type ProductRecommendation = {
  best: ProductQuote;
  alternatives: ProductQuote[];
  why: string;
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

  let why: string;
  if (priority === "rating") {
    why = `Top-rated pick, ${best.rating}★ (${best.reviews.toLocaleString("en-IN")} reviews)`;
  } else if (priority === "speed") {
    why = `Fastest delivery, ${best.deliveryDays} day${best.deliveryDays > 1 ? "s" : ""}, rated ${best.rating}★`;
  } else if (priority === "price") {
    why = `Lowest effective price after offers`;
    if (saving > 0) why += `, you save ₹${Math.round(saving / 100)} vs the next option`;
  } else {
    why = `Best overall, ${best.rating}★, ${best.deliveryDays}-day delivery`;
    if (saving > 0) why += `, and ₹${Math.round(saving / 100)} cheaper than the next`;
    else why += `, best value across sellers`;
  }
  if (topRated.rating > best.rating && priority !== "rating") {
    why += `. Highest rated: ${topRated.brand} at ${topRated.rating}★`;
  } else if (fastest.deliveryDays < best.deliveryDays && priority !== "speed") {
    why += `. Need it sooner? Another seller delivers in ${fastest.deliveryDays} day${fastest.deliveryDays > 1 ? "s" : ""}`;
  }

  return { best, alternatives, why, pickReason: reasonForPriority(priority) };
}
