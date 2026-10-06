export type FoodQuote = {
  dishId: string;
  name: string;
  restaurant: string;
  rating: number;
  ratingsCount?: number;
  tag: string;
  dietary: "veg" | "nonveg";
  reviewSummary: string;
  image?: string;
  portion?: string[];
  platform: string;
  fulfillment: "in_app";
  basePaise: number;
  deliveryFeePaise: number;
  offers: { label: string; discountPaise: number }[];
  effectivePaise: number;
  etaMinutes: number;
  addOns?: { name: string; pricePaise: number }[];
  bundleDiscountPaise?: number;
};

export type RideQuote = {
  provider: string;
  vehicle: string;
  productName: string;
  displayName: string;
  farePaise: number;
  offers: { label: string; discountPaise: number }[];
  effectivePaise: number;
  pickupEtaMinutes: number;
  rideMinutes: number;
  driverRating: number;
  fulfillment: "in_app";
  badge?: string;
};

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

export type Advice = {
  action: "order_now" | "wait";
  message: string;
  expectedSavingPaise?: number;
  waitMinutes?: number;
  contextNote?: string;
};

export type PickReason = "top_rated" | "best_price" | "fastest" | "best_overall";

type FoodRec = {
  type: "food";
  /**
   * The ranking this recommendation came from.
   *
   * Sent back when the customer orders, which is what pairs the option taken
   * with the option offered. Without it the decision log records what was
   * recommended and never what happened next.
   */
  decisionId?: string;
  best: FoodQuote;
  alternatives: FoodQuote[];
  why: string;
  advice?: Advice;
  budgetNote?: string;
  personalNote?: string;
  pickReason?: PickReason;
  /** Nothing in the catalogue matched the request; these are stand-ins. */
  substituted?: boolean;
  /** The user stated a budget and the best option exceeds it (amount over, in paise). */
  overBudgetPaise?: number;
};

type RideRec = {
  type: "ride";
  /** The ranking this recommendation came from; sent back when booking. */
  decisionId?: string;
  drop: string;
  pickup: string | null;
  /** What the rider asked for. "any" when they did not say. */
  vehicle?: "bike" | "auto" | "cab" | "any";
  quotes: RideQuote[];
  // ISO timestamp when the user asked to book for later ("cab at 10pm").
  scheduledAt?: string | null;
  /**
   * Limits the rider stated, to be applied where the real trip is priced.
   *
   * Chat quotes a placeholder distance, so it cannot honestly hold a fare to a
   * stated maximum; the booking card re-prices the actual route and applies
   * them there. Carried rather than dropped, or the reply would promise a
   * budget nothing enforces.
   */
  fareLimitPaise?: number;
  pickupLimitMinutes?: number;
  why: string;
  advice?: Advice;
};

type ShopRec = {
  type: "shop";
  best: ProductQuote;
  alternatives: ProductQuote[];
  why: string;
  personalNote?: string;
  pickReason?: PickReason;
};

export type Recommendation =
  | FoodRec
  | RideRec
  | ShopRec
  | {
      type: "combo";
      food: Omit<FoodRec, "type"> | null;
      ride: Omit<RideRec, "type">;
    };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** When it was sent, ISO. Absent on restored history that never stored one. */
  at?: string;
  domain?: string;
  recommendation?: Recommendation | null;
};
