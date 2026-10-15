import { buildContext, checkedFeePercent, hasAtMostDecimals } from "./context.js";

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
  area_code: a.areaCode,
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
          ...(o.gps ? { end: { location: { gps: o.gps, ...(o.areaCode ? { address: { area_code: o.areaCode } } : {}) } } } : {}),
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
        fulfillments: [{ end: { location: { gps: o.gps, address: { area_code: o.areaCode } } } }],
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
              location: { gps: o.delivery.gps, address: wireAddress(o.delivery.address) },
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
              location: { gps: o.delivery.gps, address: wireAddress(o.delivery.address) },
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

/** Asks the seller where an order has got to. */
export function buildStatus(o: { transactionId: string; city: string; bpp: Bpp; orderId: string }) {
  return {
    context: buildContext({ domain: DOMAIN, action: "status", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri }),
    message: { order_id: o.orderId },
  };
}
