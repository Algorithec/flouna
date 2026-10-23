// Reading a food seller's answers to an order (on_select, on_init, on_confirm,
// on_status, on_cancel, on_update).
//
// Each reader returns what Flouna needs from the message, or a problem in
// plain words. Nothing is guessed: a quote whose total is not a rupee amount,
// or whose lines do not add up to it, is reported as a problem rather than
// shown at a price the seller may not have meant.

import { PROBLEM } from "./problems.js";

type Wire = Record<string, unknown>;
const obj = (v: unknown): Wire => (v && typeof v === "object" && !Array.isArray(v) ? (v as Wire) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** "265", "265.5" or "265.50" to paise. Anything else, including negatives, is not a price. */
export function paiseOf(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d+(\.\d{1,2})?$/.test(v.trim())) return null;
  return Math.round(Number(v.trim()) * 100);
}

export type QuoteLine = {
  /** item, delivery, packing, tax, discount, misc, ... as the seller labels it. */
  type: string;
  itemId?: string;
  title: string;
  count?: number;
  paise: number;
};

export type Quote = { totalPaise: number; lines: QuoteLine[]; ttl?: string };

/**
 * The seller's price for the order. Discounts arrive as negative amounts, so
 * a line may be below zero; the total may not.
 */
export function readQuote(raw: unknown): Quote | { problem: string } {
  const q = obj(raw);
  const total = paiseOf(obj(q.price).value);
  if (total === null) return { problem: "The seller's quote has no valid total" };
  const lines: QuoteLine[] = [];
  for (const b of arr(q.breakup)) {
    const line = obj(b);
    const value = obj(line.price).value;
    const negative = typeof value === "string" && value.trim().startsWith("-");
    const amount = paiseOf(negative ? (value as string).trim().slice(1) : value);
    if (amount === null) return { problem: `The seller's quote has a line with no valid price (${String(line.title ?? "untitled")})` };
    const count = Number(obj(line["@ondc/org/item_quantity"]).count);
    lines.push({
      type: str(line["@ondc/org/title_type"]) ?? "misc",
      itemId: str(line["@ondc/org/item_id"]),
      title: str(line.title) ?? "",
      ...(Number.isSafeInteger(count) && count > 0 ? { count } : {}),
      paise: negative ? -amount : amount,
    });
  }
  if (lines.length === 0) return { problem: "The seller's quote has no breakup" };
  const sum = lines.reduce((s, l) => s + l.paise, 0);
  // A paisa of rounding across many lines is tolerated; more is a quote that
  // does not mean what it says.
  if (Math.abs(sum - total) > 1) return { problem: `The seller's quote lines add up to ${sum / 100} but the total says ${total / 100}` };
  return { totalPaise: total, lines, ...(str(q.ttl) ? { ttl: str(q.ttl) } : {}) };
}

export type Fulfillment = { id: string; category?: string; tat?: string; serviceable: boolean };

function readFulfillments(order: Wire): Fulfillment[] {
  return arr(order.fulfillments)
    .map((f): Fulfillment | null => {
      const w = obj(f);
      const id = str(w.id);
      if (!id) return null;
      const code = str(obj(obj(w.state).descriptor).code);
      return {
        id,
        category: str(w["@ondc/org/category"]),
        tat: str(w["@ondc/org/TAT"]),
        // A fulfillment the seller marks Non-serviceable cannot deliver here.
        serviceable: code !== "Non-serviceable",
      };
    })
    .filter((f): f is Fulfillment => f !== null);
}

/** The seller's error in a reply, in words a customer can read. */
export function sellerProblem(body: unknown): string | null {
  const e = obj(obj(body).error);
  const code = str(e.code) ?? (typeof e.code === "number" ? String(e.code) : undefined);
  if (!code && !str(e.message)) return null;
  const known: Record<string, string> = {
    "40002": PROBLEM.someOutOfStock,
    "30009": PROBLEM.cannotDeliver,
    "30008": PROBLEM.notServed,
    "40000": PROBLEM.notTaking,
    "30004": PROBLEM.itemGone,
    "30005": PROBLEM.storeClosed,
  };
  return (code && known[code]) ?? str(e.message) ?? `The seller refused the request (code ${code})`;
}

export type SelectReply = { quote: Quote; fulfillment: Fulfillment; outOfStock: string[]; raw: { quote: unknown } } | { problem: string };

/** on_select: the price of this cart, delivered to this point, and how. */
export function readOnSelect(body: unknown): SelectReply {
  const order = obj(obj(obj(body).message).order);
  const refused = sellerProblem(body);
  const quote = readQuote(order.quote);
  if ("problem" in quote) return { problem: refused ?? quote.problem };
  const fulfillments = readFulfillments(order);
  // Every item is sent from init on with the fulfillment the seller gave it
  // here, and ONDC checks the two match. One delivery per order is what we
  // send, so a seller splitting the cart across fulfillments is said plainly.
  const assigned = new Set(arr(order.items).map((i) => str(obj(i).fulfillment_id)).filter((s): s is string => Boolean(s)));
  if (assigned.size > 1) return { problem: refused ?? PROBLEM.splitDelivery };
  const fulfillment = fulfillments.find((f) => f.serviceable && (assigned.size === 0 || assigned.has(f.id)));
  if (!fulfillment) return { problem: refused ?? PROBLEM.cannotDeliver };
  // An item the seller cannot supply is marked in the breakup with an
  // available count of 0 (and error 40002 on the reply). The rest of the
  // quote is still the seller's price for what it can supply, so it is shown
  // with the shortage rather than thrown away.
  const outOfStock = arr(obj(order.quote).breakup)
    .map(obj)
    .filter((b) => str(b["@ondc/org/title_type"]) === "item" && obj(obj(obj(b.item).quantity).available).count === "0")
    .map((b) => str(b["@ondc/org/item_id"]))
    .filter((s): s is string => Boolean(s));
  if (refused && outOfStock.length === 0) return { problem: refused };
  // The quote as sent, from the place it was read and checked, for confirm to echo.
  return { quote, fulfillment, outOfStock, raw: { quote: order.quote } };
}

export type PaymentTerms = {
  collectedBy: "BAP" | "BPP";
  finderFee?: string;
  settlementDetails: Record<string, string>[];
  /**
   * The seller's terms (bpp_terms) as it stated them, echoed in confirm.
   * Absent on orders priced before they were kept.
   */
  sellerTerms?: { code: string; value: string }[];
  /** "percent" (the usual) or "amount": how finderFee is to be read. */
  finderFeeType?: string;
  /** When the order's money settles: "delivery", "return_window_expiry", ... */
  settlementBasis?: string;
  /** How long after the basis it settles, ISO 8601 ("P7D"). */
  settlementWindow?: string;
  /** What the collector holds back for returns, in paise. */
  withholdingPaise?: number;
};

export type InitReply = { quote: Quote; payment: PaymentTerms; raw: { quote: unknown } } | { problem: string };

/** on_init: the final terms, including who collects the money and where the seller is paid. */
export function readOnInit(body: unknown): InitReply {
  const refused = sellerProblem(body);
  if (refused) return { problem: refused };
  const order = obj(obj(obj(body).message).order);
  const quote = readQuote(order.quote);
  if ("problem" in quote) return quote;
  const p = obj(order.payment);
  const collectedBy = str(p.collected_by);
  if (collectedBy !== "BAP" && collectedBy !== "BPP") return { problem: "The seller did not say who collects the payment" };
  const settlementDetails = arr(p["@ondc/org/settlement_details"]).map((d) =>
    Object.fromEntries(Object.entries(obj(d)).filter(([, v]) => typeof v === "string")),
  ) as Record<string, string>[];
  if (collectedBy === "BAP" && settlementDetails.length === 0) {
    return { problem: "The seller did not say where to send its share of the payment" };
  }
  // Kept exactly, entry for entry, so confirm agrees to what was stated.
  const bppTerms = arr(order.tags).map(obj).find((t) => str(t.code) === "bpp_terms");
  const sellerTerms = arr(bppTerms?.list)
    .map(obj)
    .filter((e) => typeof e.code === "string" && typeof e.value === "string")
    .map((e) => ({ code: e.code as string, value: e.value as string }));
  return {
    quote,
    payment: {
      collectedBy,
      finderFee: str(p["@ondc/org/buyer_app_finder_fee_amount"]),
      finderFeeType: str(p["@ondc/org/buyer_app_finder_fee_type"]),
      settlementDetails,
      sellerTerms,
      // Settlement terms. Many sellers leave them out (the certified WITSLAB
      // flow does); ONDC's reference seller sends all three.
      settlementBasis: str(p["@ondc/org/settlement_basis"]),
      settlementWindow: str(p["@ondc/org/settlement_window"]),
      withholdingPaise: paiseOf(p["@ondc/org/withholding_amount"]) ?? undefined,
    },
    raw: { quote: order.quote },
  };
}

export const SELLER_STATES = ["Created", "Accepted", "In-progress", "Completed", "Cancelled"] as const;

export type OrderStateReply =
  | {
      sellerOrderId: string;
      sellerState: (typeof SELLER_STATES)[number];
      fulfillmentState?: string;
      quote?: Quote;
      /** The quote as sent, from where `quote` was read; present with it. */
      rawQuote?: unknown;
      cancelReasonId?: string;
      /** Who cancelled, as the seller reports it: its own id when it was the seller. */
      cancelledBy?: string;
      at?: Date;
    }
  | { problem: string };

/** on_confirm, on_status, on_cancel and on_update: where the order is now. */
export function readOrderState(body: unknown): OrderStateReply {
  const refused = sellerProblem(body);
  const order = obj(obj(obj(body).message).order);
  const id = str(order.id);
  const state = str(order.state) as (typeof SELLER_STATES)[number] | undefined;
  if (refused && !id) return { problem: refused };
  if (!id) return { problem: "The seller's reply has no order id" };
  if (!state || !SELLER_STATES.includes(state)) return { problem: `The seller sent an unknown order state (${String(order.state)})` };
  const delivery = arr(order.fulfillments).map(obj).find((f) => str(f.type) === "Delivery") ?? obj(arr(order.fulfillments)[0]);
  const fulfillmentState = str(obj(obj(delivery.state).descriptor).code);
  const quote = order.quote ? readQuote(order.quote) : undefined;
  const cancellation = obj(order.cancellation);
  const cancelReasonId = str(obj(cancellation.reason).id);
  const cancelledBy = str(cancellation.cancelled_by);
  const ts = str(obj(obj(body).context).timestamp);
  const at = ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts) : undefined;
  return {
    sellerOrderId: id,
    sellerState: state,
    ...(fulfillmentState ? { fulfillmentState } : {}),
    ...(quote && !("problem" in quote) ? { quote, rawQuote: order.quote } : {}),
    ...(cancelReasonId ? { cancelReasonId } : {}),
    ...(cancelledBy ? { cancelledBy } : {}),
    ...(at ? { at } : {}),
  };
}
