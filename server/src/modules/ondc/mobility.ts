import { buildContext, checkedFeePercent, checkedGps, checkedHttpsUrl } from "./context.js";

// Ride hailing (ONDC:TRV10, Beckn 2.0.1) message builders.
//
// Modelled on ONDC's own examples in mobility-specification, branch
// draft-TRV10-2.x: that branch is version 2.0.1 and still maintained, while
// the 2.1.0 branch was left in May 2025.
//
// Rides differ from food in where the money goes. The default is that the ride
// provider collects the fare (collected_by BPP, often cash to the driver), so
// Flouna never holds a rider's fare. The provider then owes Flouna its finder
// fee, and the payment params name where to send it: Flouna's own account.
// Settlement terms are the provider's, set in its responses and echoed back
// unchanged, because echoing them is agreeing to them.

const DOMAIN = "ONDC:TRV10" as const;

export type Stop = { gps: string; address: string; area: string };

export type VehicleCategory = "AUTO_RICKSHAW" | "CAB" | "TWO_WHEELER";

function stops(pickup: Stop, drop: Stop) {
  return [
    { location: { gps: checkedGps(pickup.gps), address: pickup.address }, type: "START" },
    { location: { gps: checkedGps(drop.gps), address: drop.address }, type: "END" },
  ];
}

function areaTags(pickup: Stop, drop: Stop) {
  return [
    {
      descriptor: { code: "LOCATION" },
      display: false,
      list: [
        { descriptor: { code: "START_AREA" }, value: pickup.area },
        { descriptor: { code: "END_AREA" }, value: drop.area },
      ],
    },
  ];
}

const finderFeeTag = (percent: number) => ({
  descriptor: { code: "BUYER_FINDER_FEES" },
  display: false,
  list: [{ descriptor: { code: "BUYER_FINDER_FEES_PERCENTAGE" }, value: String(checkedFeePercent(percent)) }],
});

/** Asks ride providers what they can offer between two points. */
export function buildRideSearch(o: {
  transactionId: string;
  city: string;
  pickup: Stop;
  drop: Stop;
  finderFeePercent: number;
  /** Where Flouna's own static terms are published. */
  staticTermsUrl: string;
  delayInterestPercent?: number;
}) {
  return {
    context: buildContext({ domain: DOMAIN, action: "search", city: o.city, transactionId: o.transactionId }),
    message: {
      intent: {
        fulfillment: { stops: stops(o.pickup, o.drop), tags: areaTags(o.pickup, o.drop) },
        payment: {
          collected_by: "BPP",
          tags: [
            finderFeeTag(o.finderFeePercent),
            {
              descriptor: { code: "SETTLEMENT_TERMS" },
              display: false,
              list: [
                { descriptor: { code: "DELAY_INTEREST" }, value: String(checkedFeePercent(o.delayInterestPercent ?? 5)) },
                { descriptor: { code: "STATIC_TERMS" }, value: checkedHttpsUrl(o.staticTermsUrl, "Static terms") },
              ],
            },
          ],
        },
      },
    },
  };
}

type RideBase = {
  transactionId: string;
  city: string;
  bpp: { id: string; uri: string };
  providerId: string;
  itemId: string;
  fulfillmentId: string;
  vehicle: VehicleCategory;
  pickup: Stop;
  drop: Stop;
};

function fulfillment(o: RideBase, customer?: { name: string; phone: string }) {
  return {
    ...(customer ? { customer: { contact: { phone: customer.phone }, person: { name: customer.name } } } : {}),
    id: o.fulfillmentId,
    stops: stops(o.pickup, o.drop),
    vehicle: { category: o.vehicle },
    tags: areaTags(o.pickup, o.drop),
  };
}

const ctx = (o: RideBase, action: string) =>
  buildContext({ domain: DOMAIN, action, city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri });

/** Picks one of the offered rides. */
export function buildRideSelect(o: RideBase) {
  return {
    context: ctx(o, "select"),
    message: { order: { items: [{ id: o.itemId }], provider: { id: o.providerId }, fulfillments: [fulfillment(o)] } },
  };
}

export type RidePayment = {
  /**
   * Only the provider collects for now. Flouna collecting a fare needs a
   * prepaid flow (type PRE-ORDER, paid before confirm, a transaction id) that
   * is not built, and sending BAP with the on-fulfilment terms below would
   * tell the provider we had taken a payment we had not.
   */
  collectedBy: "BPP";
  /** Flouna's account, where the provider settles the finder fee. */
  params: { bank_account_number?: string; bank_code?: string; virtual_payment_address?: string };
  /** The provider's payment tags from its last response, echoed unchanged. */
  tags: unknown[];
};

/** Gives the provider who is riding and how the money settles. */
export function buildRideInit(o: RideBase & { customer: { name: string; phone: string }; payment: RidePayment }) {
  if (o.payment.collectedBy !== "BPP") throw new Error("Rides are paid to the provider; Flouna collecting a fare is not built");
  return {
    context: ctx(o, "init"),
    message: {
      order: {
        billing: { name: o.customer.name },
        fulfillments: [fulfillment(o, o.customer)],
        items: [{ id: o.itemId }],
        payments: [{ collected_by: o.payment.collectedBy, params: o.payment.params, status: "NOT-PAID", tags: o.payment.tags, type: "ON-FULFILLMENT" }],
        provider: { id: o.providerId },
      },
    },
  };
}

/** Books the ride on the terms the provider returned in on_init. */
export function buildRideConfirm(o: RideBase & { customer: { name: string; phone: string }; payment: RidePayment & { id: string } }) {
  const init = buildRideInit(o);
  return {
    context: ctx(o, "confirm"),
    message: {
      order: {
        ...init.message.order,
        payments: [{ ...init.message.order.payments[0]!, id: o.payment.id }],
      },
    },
  };
}

/** Asks where a ride has got to. */
export function buildRideStatus(o: { transactionId: string; city: string; bpp: { id: string; uri: string }; orderId: string }) {
  return {
    context: buildContext({ domain: DOMAIN, action: "status", city: o.city, transactionId: o.transactionId, bppId: o.bpp.id, bppUri: o.bpp.uri }),
    message: { order_id: o.orderId },
  };
}
