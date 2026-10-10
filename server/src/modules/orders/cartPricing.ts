// The bill for a cart, in one place.
//
// The cart screen used to add up its own total from the prices it had stored
// when each item was added, and those are per-item effective prices: they
// already have that listing's offer taken off and its delivery fee added. The
// order route prices the same cart differently and correctly — one delivery
// fee for the order rather than one per item, and each listing's offer once
// rather than once per unit — so a cart of two biryanis showed a total that
// was not what the customer was charged.
//
// Two places computing money from the same items is the bug. This is the one
// definition: the order route prices with it, and the preview endpoint the
// cart screen reads answers with it, so the number on the screen is the number
// charged by construction rather than by agreement.
import { ApiError } from "../../middleware/error.js";
import { quotesForDish } from "../food/food.service.js";

export type CartItem = { dishId: string; platform: string; qty: number };

export type PricedLine = {
  dishId: string;
  platform: string;
  name: string;
  restaurant: string;
  qty: number;
  /** Unit base price, before this listing's offer. */
  pricePaise: number;
  offer: { label: string; discountPaise: number } | null;
};

export type CartBill = {
  lines: PricedLine[];
  /** Sum of unit base prices × quantity. */
  itemsTotalPaise: number;
  /** One per order: the highest among the lines, never a per-line stack. */
  deliveryFeePaise: number;
  convenienceFeePaise: number;
  offers: { label: string; discountPaise: number }[];
  offersDiscountPaise: number;
  /** Against the cheapest other platform for the same items. */
  savedPaise: number;
  totalPaise: number;
};

/**
 * Prices a cart. Throws a 404 naming nothing in particular if a line has gone
 * from the catalogue, which is what the order route already did.
 *
 * Deliberately free of the database and of the request: the caller supplies the
 * convenience fee, because whether it applies is a property of the customer's
 * subscription rather than of the cart.
 */
export function priceFoodCart(
  items: CartItem[],
  opts: { convenienceFeePaise: number },
): CartBill {
  const lines: PricedLine[] = [];
  const offers: { label: string; discountPaise: number }[] = [];
  let itemsTotalPaise = 0;
  let deliveryFeePaise = 0;
  let offersDiscountPaise = 0;
  let savedPaise = 0;

  // One line per listing, quantities added together.
  //
  // Each listing's offer comes off once per LINE, so the same dish on the same
  // platform sent as several lines took its offer off several times. Three
  // separate lines of one pasta were billed at ₹527 where a single line of
  // three was ₹587, and the request shape is the caller's to choose: thirty
  // lines of a ₹30-off dish were ₹870 of discount that does not exist. Merging
  // first makes the bill a function of what is in the cart rather than of how
  // it was written down, and leaves a genuine two-dish cart priced exactly as
  // before.
  const merged: CartItem[] = [];
  const lineAt = new Map<string, CartItem>();
  for (const item of items) {
    const key = `${item.dishId}@${item.platform}`;
    const seen = lineAt.get(key);
    if (seen) {
      seen.qty += item.qty;
      continue;
    }
    const line = { ...item };
    lineAt.set(key, line);
    merged.push(line);
  }

  for (const item of merged) {
    const quotes = quotesForDish(item.dishId);
    const quote = quotes.find((q) => q.platform === item.platform);
    if (!quote) {
      throw new ApiError(404, `An item in your cart is no longer available`);
    }
    itemsTotalPaise += quote.basePaise * item.qty;
    // One delivery per order — the highest fee among the lines.
    deliveryFeePaise = Math.max(deliveryFeePaise, quote.deliveryFeePaise);
    const lineOffer = quote.offers[0] ?? null;
    if (lineOffer) {
      offersDiscountPaise += lineOffer.discountPaise;
      offers.push(lineOffer);
    }
    const cheapestOther = Math.min(
      ...quotes
        .filter((q) => q.platform !== item.platform)
        .map((q) => q.effectivePaise),
    );
    if (Number.isFinite(cheapestOther)) {
      savedPaise += Math.max(0, cheapestOther - quote.effectivePaise);
    }
    lines.push({
      dishId: item.dishId,
      platform: item.platform,
      name: quote.name,
      restaurant: quote.restaurant,
      qty: item.qty,
      pricePaise: quote.basePaise,
      offer: lineOffer,
    });
  }

  return {
    lines,
    itemsTotalPaise,
    deliveryFeePaise,
    convenienceFeePaise: opts.convenienceFeePaise,
    offers,
    offersDiscountPaise,
    savedPaise,
    // Before any promo code: a code is checked against the customer and their
    // history, so it is applied by the caller that knows both.
    totalPaise: Math.max(
      0,
      itemsTotalPaise + deliveryFeePaise + opts.convenienceFeePaise - offersDiscountPaise,
    ),
  };
}
