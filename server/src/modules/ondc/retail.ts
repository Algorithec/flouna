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

/** Asks the network what is available, optionally for a named dish, delivered to a point. */
export function buildSearch(o: {
  transactionId: string;
  city: string;
  finderFeePercent: number;
  query?: string;
  gps?: string;
  areaCode?: string;
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

function wireItems(lines: CartLine[], locationId: string) {
  if (lines.length === 0) throw new Error("An ONDC order needs at least one item");
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
      ...(l.parentItemId ? { parent_item_id: l.parentItemId } : {}),
      tags: [{ code: "type", list: [{ code: "type", value: "item" }] }],
    },
    ...(l.customizations ?? []).map((c) => ({
      id: c.itemId,
      quantity: { count: l.count },
      location_id: locationId,
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
        items: wireItems(o.lines, o.locationId),
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

/**
 * Places the order on the terms the seller returned in on_init.
 *
 * `quote` and the seller's settlement details are echoed back exactly as the
 * seller sent them: confirming is agreeing to those terms, and altering either
 * on the way back would be agreeing to something the seller never offered.
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
  },
) {
  checkConfirmPayment(o.quote, o.payment);
  const at = o.billing.at.toISOString();
  return {
    context: buildContext({ domain: DOMAIN, action: "confirm", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri }),
    message: {
      order: {
        id: o.orderId,
        state: "Created",
        provider: { id: o.providerId, locations: [{ id: o.locationId }] },
        items: wireItems(o.lines, o.locationId),
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
        created_at: at,
        updated_at: at,
      },
    },
  };
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
 * The reasons a buyer app may give for cancelling, from ONDC's retail
 * cancellation codes. A seller is entitled to refuse any other code from us.
 */
export const BUYER_CANCEL_REASONS = {
  "001": "Price of one or more items changed and more payment was asked for",
  "003": "Product available at a lower price",
  "006": "Order not shipped within the promised time",
  "009": "Wrong delivery address",
  "010": "Buyer wants to change the address or other order details",
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
