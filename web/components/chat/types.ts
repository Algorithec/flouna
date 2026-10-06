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
  drop: string;
  pickup: string | null;
  /** What the rider asked for. "any" when they did not say. */
  vehicle?: "bike" | "auto" | "cab" | "any";
  quotes: RideQuote[];
  // ISO timestamp when the user asked to book for later ("cab at 10pm").
  scheduledAt?: string | null;
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
