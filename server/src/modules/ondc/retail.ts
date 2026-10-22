import { buildContext, checkedAreaCode, checkedFeePercent, checkedGps, hasAtMostDecimals } from "./context.js";

// Food (ONDC:RET11, Beckn 1.2.0) message builders.
//
// Each one turns what Flouna knows about an order into the exact message a
// seller app expects. They are modelled on a buyer app's certified pre-prod
// flow published by ONDC (v1.2.0-logs), because ONDC's certification compares
// field by field and the prose specification leaves many of them implicit.
//
// Prices on the wire are rupee strings with two decimals. Flouna holds every
// amount as integer paise, and converts only here, at the boundary.

const DOMAIN = "ONDC:RET11" as const;

export function rupees(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) throw new Error(`Not a paise amount: ${paise}`);
  return (paise / 100).toFixed(2);
}

export type Bpp = { id: string; uri: string };

export type Address = {
  name: string;
  building: string;
  locality: string;
  city: string;
  state: string;
  areaCode: string;
};

const wireAddress = (a: Address) => ({
  name: a.name,
  building: a.building,
  locality: a.locality,
  city: a.city,
  state: a.state,
  country: "IND",
  area_code: checkedAreaCode(a.areaCode),
});

const finderFee = (percent: number) => ({
  "@ondc/org/buyer_app_finder_fee_type": "percent",
  // Whole and one decimal fees keep the "3.0" form the certified flows use;
  // anything finer is stated exactly rather than rounded to a different fee.
  "@ondc/org/buyer_app_finder_fee_amount": hasAtMostDecimals(checkedFeePercent(percent), 1)
    ? percent.toFixed(1)
    : percent.toFixed(2),
});

/** Our published static terms: where they are and from when they apply. */
export type StaticTerms = { url: string; effectiveDate: string };

/**
 * Asks the network what is available, optionally for a named dish, delivered to a point.
 *
 * With our static terms, the search states them (bap_terms), so every seller
 * that answers has been shown the terms it transacts under. static_terms is
 * the version being replaced and stays empty until a second version replaces
 * the first; static_terms_new is the version in force from effective_date.
 */
export function buildSearch(o: {
  transactionId: string;
  city: string;
  finderFeePercent: number;
  query?: string;
  gps?: string;
  areaCode?: string;
  staticTerms?: StaticTerms | null;
}) {
  return {
    context: buildContext({ domain: DOMAIN, action: "search", city: o.city, transactionId: o.transactionId }),
    message: {
      intent: {
        ...(o.query ? { item: { descriptor: { name: o.query } } } : {}),
        fulfillment: {
          type: "Delivery",
          ...(o.gps
            ? { end: { location: { gps: checkedGps(o.gps), ...(o.areaCode ? { address: { area_code: checkedAreaCode(o.areaCode) } } : {}) } } }
            : {}),
        },
        payment: finderFee(o.finderFeePercent),
        ...(o.staticTerms
          ? {
              tags: [
                {
                  code: "bap_terms",
                  list: [
                    { code: "static_terms", value: "" },
                    { code: "static_terms_new", value: o.staticTerms.url },
                    { code: "effective_date", value: o.staticTerms.effectiveDate },
                  ],
                },
              ],
            }
          : {}),
      },
    },
  };
}

export type CartLine = {
  itemId: string;
  count: number;
  /** The id the seller groups this line under, from its catalogue. */
  parentItemId?: string;
  /** Variants and add-ons, each tied to its customisation group. */
  customizations?: { itemId: string; groupId: string }[];
};

/**
 * The cart as items on the wire. From init on, each item names the fulfillment
 * it goes out with (the one the seller offered in on_select): ONDC's retail
 * schema requires it there, and the certified flows send it on every item,
 * add-ons included.
 */
function wireItems(lines: CartLine[], locationId: string, fulfillmentId?: string) {
  if (lines.length === 0) throw new Error("An ONDC order needs at least one item");
  const fulfillment = fulfillmentId ? { fulfillment_id: fulfillmentId } : {};
  for (const l of lines) {
    if (!Number.isSafeInteger(l.count) || l.count < 1) throw new Error(`Item ${l.itemId} has a count of ${l.count}`);
    // A seller ties an add-on to its dish through parent_item_id. Without it
    // the add-on arrives as a separate, unattached item.
    if (l.customizations?.length && !l.parentItemId) {
      throw new Error(`Item ${l.itemId} has customisations but no parent item id to tie them to`);
    }
  }
  return lines.flatMap((l) => [
    {
      id: l.itemId,
      quantity: { count: l.count },
      location_id: locationId,
      ...fulfillment,
      ...(l.parentItemId ? { parent_item_id: l.parentItemId } : {}),
      tags: [{ code: "type", list: [{ code: "type", value: "item" }] }],
    },
    ...(l.customizations ?? []).map((c) => ({
      id: c.itemId,
      quantity: { count: l.count },
      location_id: locationId,
      ...fulfillment,
      ...(l.parentItemId ? { parent_item_id: l.parentItemId } : {}),
      tags: [
        { code: "type", list: [{ code: "type", value: "customization" }] },
        { code: "parent", list: [{ code: "id", value: c.groupId }] },
      ],
    })),
  ]);
}

type OrderBase = {
  transactionId: string;
  city: string;
  bpp: Bpp;
  providerId: string;
  locationId: string;
  lines: CartLine[];
};

/** Asks the seller to price this exact cart for this delivery point. */
export function buildSelect(o: OrderBase & { gps: string; areaCode: string }) {
  return {
    context: buildContext({ domain: DOMAIN, action: "select", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri }),
    message: {
      order: {
        provider: { id: o.providerId, locations: [{ id: o.locationId }] },
        items: wireItems(o.lines, o.locationId),
        fulfillments: [{ end: { location: { gps: checkedGps(o.gps), address: { area_code: checkedAreaCode(o.areaCode) } } } }],
      },
    },
  };
}

export type Delivery = {
  fulfillmentId: string;
  gps: string;
  address: Address;
  phone: string;
  email: string;
};

/** Gives the seller who is paying and where it goes, so it can return final terms. */
export function buildInit(o: OrderBase & { billing: { name: string; phone: string; email: string; address: Address; at: Date }; delivery: Delivery }) {
  const at = o.billing.at.toISOString();
  return {
    context: buildContext({ domain: DOMAIN, action: "init", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri }),
    message: {
      order: {
        provider: { id: o.providerId, locations: [{ id: o.locationId }] },
        items: wireItems(o.lines, o.locationId, o.delivery.fulfillmentId),
        billing: {
          name: o.billing.name,
          phone: o.billing.phone,
          email: o.billing.email,
          address: wireAddress(o.billing.address),
          created_at: at,
          updated_at: at,
        },
        fulfillments: [
          {
            id: o.delivery.fulfillmentId,
            type: "Delivery",
            end: {
              contact: { email: o.delivery.email, phone: o.delivery.phone },
              location: { gps: checkedGps(o.delivery.gps), address: wireAddress(o.delivery.address) },
            },
          },
        ],
      },
    },
  };
}

export type SettlementDetail = Record<string, string>;

/** A tag's list as ONDC sends it, e.g. the seller's bpp_terms from on_init. */
export type TermsList = { code: string; value: string }[];

/** The shape of a GSTIN, as ONDC's retail log validator checks it. */
export const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * Places the order on the terms the seller returned in on_init.
 *
 * `quote`, the seller's settlement details and the seller's terms (bpp_terms)
 * are echoed back exactly as the seller sent them: confirming is agreeing to
 * those terms, and altering any of them on the way back would be agreeing to
 * something the seller never offered. Our own terms (bap_terms) carry
 * Algorithec's GSTIN, which the seller needs to invoice the finder fee.
 *
 * Who collects the money is a business decision, not a protocol one. "BAP"
 * means Flouna takes the payment and owes the seller its share (the settlement
 * details say where); "BPP" means the seller collects and Flouna handles none
 * of the seller's money.
 */
export function buildConfirm(
  o: OrderBase & {
    orderId: string;
    billing: { name: string; phone: string; email: string; address: Address; at: Date };
    delivery: Delivery & { personName: string; tat: string };
    quote: unknown;
    payment: {
      collectedBy: "BAP" | "BPP";
      amountPaise: number;
      gatewayTransactionId?: string;
      paid: boolean;
      finderFeePercent: number;
      settlementDetails: SettlementDetail[];
    };
    terms: { seller: TermsList; buyerGstin: string };
    now?: Date;
  },
) {
  checkConfirmPayment(o.quote, o.payment);
  checkConfirmTerms(o.terms);
  // Billing keeps the time it was given in init, which confirm must repeat.
  // The order itself is created now: ONDC checks its created_at and
  // updated_at against this message's own timestamp, as certified flows send.
  const at = o.billing.at.toISOString();
  const now = o.now ?? new Date();
  return {
    context: buildContext({ domain: DOMAIN, action: "confirm", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri, now }),
    message: {
      order: {
        id: o.orderId,
        state: "Created",
        provider: { id: o.providerId, locations: [{ id: o.locationId }] },
        items: wireItems(o.lines, o.locationId, o.delivery.fulfillmentId),
        billing: {
          name: o.billing.name,
          phone: o.billing.phone,
          email: o.billing.email,
          address: wireAddress(o.billing.address),
          created_at: at,
          updated_at: at,
        },
        fulfillments: [
          {
            id: o.delivery.fulfillmentId,
            type: "Delivery",
            tracking: true,
            "@ondc/org/TAT": o.delivery.tat,
            end: {
              person: { name: o.delivery.personName },
              contact: { phone: o.delivery.phone },
              location: { gps: checkedGps(o.delivery.gps), address: wireAddress(o.delivery.address) },
            },
          },
        ],
        quote: o.quote,
        payment: {
          type: "ON-ORDER",
          collected_by: o.payment.collectedBy,
          status: o.payment.paid ? "PAID" : "NOT-PAID",
          params: {
            amount: rupees(o.payment.amountPaise),
            currency: "INR",
            ...(o.payment.gatewayTransactionId ? { transaction_id: o.payment.gatewayTransactionId } : {}),
          },
          ...finderFee(o.payment.finderFeePercent),
          "@ondc/org/settlement_details": o.payment.settlementDetails,
        },
        tags: [
          // A seller that stated no terms gets none echoed: we cannot agree to
          // terms on its behalf.
          ...(o.terms.seller.length ? [{ code: "bpp_terms", list: o.terms.seller }] : []),
          { code: "bap_terms", list: [{ code: "tax_number", value: o.terms.buyerGstin }] },
        ],
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    },
  };
}

/**
 * Our GSTIN must be one, and must not be the seller's: ONDC's validator
 * refuses a confirm whose two tax numbers are the same, and a seller invoicing
 * itself for our fee would be a mix-up worth stopping before it is sent.
 */
function checkConfirmTerms(t: { seller: TermsList; buyerGstin: string }) {
  if (!GSTIN.test(t.buyerGstin)) throw new Error(`Our GSTIN is not a GSTIN: ${t.buyerGstin}`);
  for (const e of t.seller) {
    if (typeof e?.code !== "string" || typeof e?.value !== "string") throw new Error("The seller's terms have an entry that is not a code and value");
  }
  if (t.seller.some((e) => e.code === "tax_number" && e.value === t.buyerGstin)) {
    throw new Error("The seller's GSTIN is the same as ours");
  }
}

/**
 * The money in a confirm must agree with itself before it is sent. The amount
 * is what the customer was charged, the quote is what the seller asked for,
 * and if they differ we would be confirming an order at a price nobody agreed.
 * When Flouna collects, the order must actually be paid and the seller's
 * settlement details present, or we would be telling the seller it will be
 * paid with no record of the payment and nowhere to send its share.
 */
function checkConfirmPayment(
  quote: unknown,
  p: {
    collectedBy: "BAP" | "BPP";
    amountPaise: number;
    gatewayTransactionId?: string;
    paid: boolean;
    settlementDetails: SettlementDetail[];
  },
) {
  const value = (quote as { price?: { value?: unknown } } | null)?.price?.value;
  const quotedPaise =
    typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : Number.NaN;
  if (quotedPaise !== p.amountPaise) {
    throw new Error(`Payment of ${rupees(p.amountPaise)} does not match the seller's quote of ${String(value)}`);
  }
  if (p.collectedBy === "BAP") {
    if (!p.paid) throw new Error("Flouna collects this order, so it must be paid before it is confirmed");
    if (!p.gatewayTransactionId) throw new Error("A paid order needs the payment's transaction id");
    if (p.settlementDetails.length === 0) {
      throw new Error("Flouna collects this order, so the seller's settlement details are needed");
    }
  }
}

/** Asks the seller where an order has got to. */
export function buildStatus(o: { transactionId: string; city: string; bpp: Bpp; orderId: string }) {
  return {
    context: buildContext({ domain: DOMAIN, action: "status", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri }),
    message: { order_id: o.orderId },
  };
}

/**
 * The reasons a buyer app may give for cancelling: the codes ONDC's retail
 * specification marks "Who can use code: Buyer NP" (error_codes/Cancellation
 * in ONDC-RET-Specifications). A seller is entitled to refuse any other code
 * from us. 009 is a wrong product delivered, not a wrong address; a changed
 * address is 010.
 */
export const BUYER_CANCEL_REASONS = {
  "001": "Price of one or more items changed and more payment was asked for",
  "003": "Product available at a lower price",
  "006": "Order not shipped within the promised time",
  "009": "Wrong product delivered",
  "010": "Buyer wants to modify the address or other order details",
} as const;
export type BuyerCancelReason = keyof typeof BUYER_CANCEL_REASONS;

/** Asks the seller to cancel a placed order, for one of the buyer reasons above. */
export function buildCancel(o: { transactionId: string; city: string; bpp: Bpp; orderId: string; reasonId: BuyerCancelReason }) {
  if (!(o.reasonId in BUYER_CANCEL_REASONS)) throw new Error(`Not a buyer cancellation reason: ${o.reasonId}`);
  return {
    context: buildContext({ domain: DOMAIN, action: "cancel", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri }),
    message: { order_id: o.orderId, cancellation_reason_id: o.reasonId },
  };
}

/** Asks the seller for a live tracking link. The answer arrives as on_track. */
export function buildTrack(o: { transactionId: string; city: string; bpp: Bpp; orderId: string }) {
  return {
    context: buildContext({ domain: DOMAIN, action: "track", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri }),
    message: { order_id: o.orderId },
  };
}
