import { paiseOf, readQuote, type Quote } from "./orderReplies.js";

// Reading ride providers' answers (ONDC:TRV10 2.0.1): the rides they offer,
// the fare for one, their payment terms, and where a booked ride has got to.
// Modelled on the examples in ONDC's mobility specification (draft-TRV10-2.x).
//
// Some of ONDC's own status examples carry the ride's state without the order
// id or the order status, so neither is required here; the order is found
// from the transaction and the verified sender instead.

type Wire = Record<string, unknown>;
const obj = (v: unknown): Wire => (v && typeof v === "object" && !Array.isArray(v) ? (v as Wire) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A TRV10 tag group's values: `{ descriptor: { code }, list: [{ descriptor: { code }, value }] }`. */
function tagValue(tags: unknown, group: string, code: string): string | undefined {
  for (const t of arr(tags).map(obj)) {
    if (str(obj(t.descriptor).code) !== group) continue;
    for (const e of arr(t.list).map(obj)) if (str(obj(e.descriptor).code) === code) return str(e.value);
  }
  return undefined;
}

export type RideOffer = {
  bppId: string;
  bppUri: string;
  /** The provider app's name ("Namma Yatri"), or its id when it gave none. */
  appName: string;
  providerId: string;
  providerName?: string;
  itemId: string;
  fulfillmentId: string;
  vehicle: string; // AUTO_RICKSHAW | CAB | TWO_WHEELER | ...
  variant?: string;
  farePaise: number;
  /** The provider's estimate range, when it gave one. */
  minPaise?: number;
  maxPaise?: number;
  collectedBy?: string;
  /** The provider's payment tags in its catalogue, echoed back at init. */
  paymentTags: unknown[];
};

/** Every ride a provider's on_search offers, one per vehicle it quoted. */
export function parseRideOnSearch(body: unknown): RideOffer[] {
  const ctx = obj(obj(body).context);
  const bppId = str(ctx.bpp_id);
  const bppUri = str(ctx.bpp_uri);
  if (!bppId || !bppUri) return [];
  const catalog = obj(obj(obj(body).message).catalog);
  const appName = str(obj(catalog.descriptor).name) ?? bppId;
  const offers: RideOffer[] = [];
  for (const p of arr(catalog.providers).map(obj)) {
    const providerId = str(p.id);
    if (!providerId) continue;
    const fulfillments = new Map(arr(p.fulfillments).map(obj).map((f) => [str(f.id), f] as const));
    const payment = obj(arr(p.payments)[0]);
    const collectedBy = str(payment.collected_by);
    for (const i of arr(p.items).map(obj)) {
      const itemId = str(i.id);
      const fulfillmentId = str(arr(i.fulfillment_ids)[0]);
      const f = fulfillments.get(fulfillmentId);
      const price = obj(i.price);
      const farePaise = paiseOf(price.value);
      const vehicle = str(obj(f?.vehicle).category);
      if (!itemId || !fulfillmentId || !f || !vehicle || farePaise === null || farePaise <= 0) continue;
      const minPaise = paiseOf(price.minimum_value);
      const maxPaise = paiseOf(price.maximum_value);
      offers.push({
        bppId,
        bppUri,
        appName,
        providerId,
        ...(str(obj(p.descriptor).name) ? { providerName: str(obj(p.descriptor).name) } : {}),
        itemId,
        fulfillmentId,
        vehicle,
        ...(str(obj(f.vehicle).variant) ? { variant: str(obj(f.vehicle).variant) } : {}),
        farePaise,
        ...(minPaise !== null ? { minPaise } : {}),
        ...(maxPaise !== null ? { maxPaise } : {}),
        ...(collectedBy ? { collectedBy } : {}),
        paymentTags: arr(payment.tags),
      });
    }
  }
  return offers;
}

/** on_select: the provider's fare for the chosen ride. */
export function readRideOnSelect(body: unknown): { quote: Quote; raw: unknown } | { problem: string } {
  const problem = rideProblem(body);
  if (problem) return { problem };
  const order = obj(obj(obj(body).message).order);
  const quote = readQuote(order.quote);
  if ("problem" in quote) return quote;
  return { quote, raw: order.quote };
}

export type RidePaymentTerms = {
  id?: string;
  collectedBy: string;
  /** The provider's payment tags, echoed back unchanged at confirm. */
  tags: unknown[];
  finderFeePercent?: string;
  settlementWindow?: string;
};

/** on_init: the provider's payment terms (with the payment id confirm must quote) and final fare. */
export function readRideOnInit(body: unknown): { quote: Quote; payment: RidePaymentTerms; cancellationTerms: unknown } | { problem: string } {
  const problem = rideProblem(body);
  if (problem) return { problem };
  const order = obj(obj(obj(body).message).order);
  const quote = readQuote(order.quote);
  if ("problem" in quote) return quote;
  const p = obj(arr(order.payments)[0]);
  const collectedBy = str(p.collected_by);
  if (!collectedBy) return { problem: "The provider did not say who collects the fare" };
  return {
    quote,
    payment: {
      ...(str(p.id) ? { id: str(p.id) } : {}),
      collectedBy,
      tags: arr(p.tags),
      ...(tagValue(p.tags, "BUYER_FINDER_FEES", "BUYER_FINDER_FEES_PERCENTAGE") ? { finderFeePercent: tagValue(p.tags, "BUYER_FINDER_FEES", "BUYER_FINDER_FEES_PERCENTAGE") } : {}),
      ...(tagValue(p.tags, "SETTLEMENT_TERMS", "SETTLEMENT_WINDOW") ? { settlementWindow: tagValue(p.tags, "SETTLEMENT_TERMS", "SETTLEMENT_WINDOW") } : {}),
    },
    cancellationTerms: order.cancellation_terms ?? null,
  };
}

export const RIDE_ORDER_STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED", "SOFT_CANCEL"] as const;

export type RideState = {
  orderId?: string;
  status?: (typeof RIDE_ORDER_STATUSES)[number];
  /** RIDE_ASSIGNED, RIDE_ENROUTE_PICKUP, RIDE_ARRIVED_PICKUP, RIDE_STARTED, RIDE_ENDED, RIDE_CANCELLED, ... */
  rideState?: string;
  driver?: { name?: string; phone?: string };
  vehicle?: { registration?: string; make?: string; model?: string; category?: string; color?: string };
  /** The code the rider gives the driver to start the ride. */
  startOtp?: string;
  quote?: Quote;
  rawQuote?: unknown;
  at?: Date;
};

/** on_confirm, on_status, on_update, on_cancel: where the ride stands. */
export function readRideState(body: unknown): RideState | { problem: string } {
  const problem = rideProblem(body);
  const order = obj(obj(obj(body).message).order);
  if (problem && !str(order.id)) return { problem };
  const status = str(order.status) as RideState["status"];
  if (status && !RIDE_ORDER_STATUSES.includes(status)) return { problem: `The provider sent an unknown ride status (${status})` };
  const f = obj(arr(order.fulfillments)[0]);
  const agent = obj(f.agent);
  const vehicle = obj(f.vehicle);
  const start = arr(f.stops).map(obj).find((s) => str(s.type) === "START");
  const auth = obj(start?.authorization);
  const quote = order.quote ? readQuote(order.quote) : undefined;
  const ts = str(obj(obj(body).context).timestamp);
  const at = ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts) : undefined;
  const driverName = str(obj(agent.person).name);
  const driverPhone = str(obj(agent.contact).phone);
  return {
    ...(str(order.id) ? { orderId: str(order.id) } : {}),
    ...(status ? { status } : {}),
    ...(str(obj(obj(f.state).descriptor).code) ? { rideState: str(obj(obj(f.state).descriptor).code) } : {}),
    ...(driverName || driverPhone ? { driver: { ...(driverName ? { name: driverName } : {}), ...(driverPhone ? { phone: driverPhone } : {}) } } : {}),
    ...(str(vehicle.registration)
      ? {
          vehicle: Object.fromEntries(
            (["registration", "make", "model", "category", "color"] as const).filter((k) => str(vehicle[k])).map((k) => [k, str(vehicle[k])]),
          ),
        }
      : {}),
    ...(str(auth.type) === "OTP" && str(auth.token) ? { startOtp: str(auth.token) } : {}),
    ...(quote && !("problem" in quote) ? { quote, rawQuote: order.quote } : {}),
    ...(at ? { at } : {}),
  };
}

/** on_track: a live link, or the vehicle's last position. */
export function readRideTrack(body: unknown): { url?: string; gps?: string; updatedAt?: string } | null {
  const t = obj(obj(obj(body).message).tracking);
  const url = str(t.url);
  const gps = str(obj(t.location).gps);
  if (url && /^https:\/\//.test(url)) return { url };
  if (gps) return { gps, ...(str(obj(t.location).updated_at) ? { updatedAt: str(obj(t.location).updated_at) } : {}) };
  return null;
}

function rideProblem(body: unknown): string | null {
  const e = obj(obj(body).error);
  const code = str(e.code) ?? (typeof e.code === "number" ? String(e.code) : undefined);
  if (!code && !str(e.message)) return null;
  return str(e.message) ?? `The provider refused the request (code ${code})`;
}
