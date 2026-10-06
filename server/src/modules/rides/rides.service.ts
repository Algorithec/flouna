// Simulated ride-provider quotes (Uber/Ola/Rapido/ONDC). Same adapter shape
// real provider/ONDC-mobility integrations will implement later.
import { qualityOf, type CommunityRating } from "../ratings/blend.js";
import { googleRoute } from "../maps/googleRoutes.js";
import {
  scoreOptions,
  appliedWeights,
  type Priority,
  type DecisionTrace,
} from "../advisor/scoring.js";
import {
  applyHardConstraints,
  type HardConstraints,
  type NearestMiss,
} from "../advisor/constraints.js";

// Great-circle distance between two coordinates.
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Authoritative trip estimate from coordinates — the ONLY trusted source of
// distance/time for fare calculation. Never trust a client-supplied distance,
// or a tampering tool could fake a short trip to underpay. (When ORS/Geoapify
// keys are configured the /route endpoint refines this; the order endpoint
// always recomputes from coordinates so the booked fare can't be gamed.)
export function estimateTrip(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): { distanceKm: number; rideMinutes: number } {
  const crowKm = haversineKm(fromLat, fromLng, toLat, toLng);
  const distanceKm = Math.max(1, crowKm * 1.3); // road-winding factor
  return {
    distanceKm,
    rideMinutes: Math.max(5, Math.round((distanceKm / 25) * 60)),
  };
}

export type RouteResult = {
  distanceKm: number;
  rideMinutes: number;
  geometry: [number, number][]; // [lng, lat][]
};

// Server-side route lookup with offline fallback. Used by the /route endpoint
// and at booking time so the live-tracking marker has real road geometry.
// The same trip, priced twice, must cost the same.
//
// A ride's fare comes from the route distance, looked up once for the screen
// and again when the order is placed, since a distance from the client is
// never trusted. Google routes with live traffic, and its shortest
// alternative can change between the two: the review button said ₹413 and the
// order charged ₹476. So a route is remembered for ten minutes, long enough to
// cover choosing and booking, and short enough that it is still today's road.
// It also spares a billed call when the same trip is asked for again.
const ROUTE_TTL_MS = 10 * 60_000;
const ROUTE_CACHE_MAX = 500;
const routeCache = new Map<string, { at: number; route: RouteResult }>();

/** Five decimals is about a metre: the same pin, not merely a nearby one. */
function routeKey(fromLat: number, fromLng: number, toLat: number, toLng: number): string {
  return [fromLat, fromLng, toLat, toLng].map((n) => n.toFixed(5)).join(",");
}

/** For tests: forget every remembered route. */
export function clearRouteCache() {
  routeCache.clear();
}

export async function fetchRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  orsKey?: string,
  googleKey?: string,
): Promise<RouteResult> {
  const key = routeKey(fromLat, fromLng, toLat, toLng);
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < ROUTE_TTL_MS) return hit.route;

  const route = await lookupRoute(fromLat, fromLng, toLat, toLng, orsKey, googleKey);
  routeCache.delete(key);
  routeCache.set(key, { at: Date.now(), route });
  // Oldest first in a Map, so the first key is the one to drop.
  if (routeCache.size > ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (oldest !== undefined) routeCache.delete(oldest);
  }
  return route;
}

async function lookupRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  orsKey?: string,
  googleKey?: string,
): Promise<RouteResult> {
  // Google first when it is configured: real roads, live traffic, and the
  // shortest of its alternatives, so the line both people see is the one the
  // fare is priced on. Any failure falls through to the providers below.
  if (googleKey) {
    const g = await googleRoute(
      googleKey,
      { latitude: fromLat, longitude: fromLng },
      { latitude: toLat, longitude: toLng },
    );
    if (g) return g;
  }
  if (orsKey) {
    try {
      // Hard timeout: if ORS is slow or down (it 502s intermittently), don't
      // hang the ride quote — fall back to the offline estimate fast. Without
      // this, a hanging ORS call surfaces to the user as "could not calculate
      // the route" instead of a working straight-line estimate.
      const r = await fetch(
        "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: orsKey },
          body: JSON.stringify({
            coordinates: [
              [fromLng, fromLat],
              [toLng, toLat],
            ],
          }),
          signal: AbortSignal.timeout(4000),
        },
      );
      if (r.ok) {
        const data = (await r.json()) as {
          features?: Array<{
            geometry: { coordinates: [number, number][] };
            properties: { summary: { distance: number; duration: number } };
          }>;
        };
        const f = data.features?.[0];
        if (f)
          return {
            distanceKm: f.properties.summary.distance / 1000,
            rideMinutes: Math.round(f.properties.summary.duration / 60),
            geometry: f.geometry.coordinates,
          };
      }
    } catch {
      // fall through to offline estimate
    }
  }
  const { distanceKm, rideMinutes } = estimateTrip(fromLat, fromLng, toLat, toLng);
  return {
    distanceKm,
    rideMinutes,
    geometry: [
      [fromLng, fromLat],
      [toLng, toLat],
    ],
  };
}

export type VehicleType = "bike" | "auto" | "cab";

export type RideQuote = {
  provider: "uber" | "ola" | "rapido" | "ondc";
  vehicle: VehicleType;
  productName: string; // internal id, order matching keys on this
  displayName: string; // what users see: neutral tier, no network brand
  farePaise: number;
  offers: { label: string; discountPaise: number }[];
  effectivePaise: number;
  pickupEtaMinutes: number;
  rideMinutes: number;
  driverRating: number;
  fulfillment: "in_app"; // always in-app; ONDC routes to the provider
  badge?: string;
};

type ProviderConfig = {
  provider: RideQuote["provider"];
  products: Array<{
    vehicle: VehicleType;
    name: string;
    displayName: string;
    basePaise: number;
    perKmPaise: number;
    pickupEta: number;
    rating: number;
    offer?: { label: string; discountPaise: number };
  }>;
};

// `name` is the internal product id (stable — order matching + tests key on it).
// `displayName` is what users see: neutral service tiers with NO network brand —
// users book with Flouna; ONDC routes to whichever registered partner fulfils.
const providers: ProviderConfig[] = [
  {
    provider: "uber",
    products: [
      { vehicle: "bike", name: "Uber Moto", displayName: "Bike", basePaise: 2000, perKmPaise: 600, pickupEta: 5, rating: 4.7 },
      { vehicle: "auto", name: "Uber Auto", displayName: "Auto", basePaise: 3000, perKmPaise: 1100, pickupEta: 4, rating: 4.9 },
      { vehicle: "cab", name: "Uber Go", displayName: "Cab", basePaise: 5000, perKmPaise: 1600, pickupEta: 6, rating: 4.8 },
    ],
  },
  {
    provider: "ola",
    products: [
      { vehicle: "bike", name: "Ola Bike", displayName: "Bike Lite", basePaise: 1800, perKmPaise: 580, pickupEta: 7, rating: 4.4 },
      { vehicle: "auto", name: "Ola Auto", displayName: "Auto Plus", basePaise: 2800, perKmPaise: 1050, pickupEta: 6, rating: 4.5, offer: { label: "Coupon RIDE50", discountPaise: 5000 } },
      { vehicle: "cab", name: "Ola Mini", displayName: "Cab Mini", basePaise: 4800, perKmPaise: 1500, pickupEta: 8, rating: 4.4 },
    ],
  },
  {
    provider: "rapido",
    products: [
      { vehicle: "bike", name: "Rapido Bike", displayName: "Bike Express", basePaise: 1500, perKmPaise: 520, pickupEta: 3, rating: 4.3, offer: { label: "First ride ₹25 off", discountPaise: 2500 } },
      { vehicle: "auto", name: "Rapido Auto", displayName: "Auto Express", basePaise: 2600, perKmPaise: 1000, pickupEta: 7, rating: 4.2 },
    ],
  },
  {
    provider: "ondc",
    products: [
      { vehicle: "auto", name: "ONDC Auto", displayName: "Auto Saver", basePaise: 2400, perKmPaise: 950, pickupEta: 6, rating: 4.3, offer: { label: "Smart network pricing", discountPaise: 1500 } },
      { vehicle: "cab", name: "ONDC Cab", displayName: "Cab Saver", basePaise: 4200, perKmPaise: 1400, pickupEta: 9, rating: 4.2 },
    ],
  },
];

export type QuoteRidesOpts = {
  distanceKm: number;
  rideMinutes: number;
  vehicle?: VehicleType | "any";
  priority?: Priority;
};

export function quoteRides(opts: QuoteRidesOpts): RideQuote[] {
  return quoteRidesTraced(opts).quotes;
}

// Same quoting, but also reporting how the ordering was reached. Kept as the
// single implementation so a logged explanation cannot drift from behaviour.
export function quoteRidesTraced(
  opts: QuoteRidesOpts & {
    /**
     * What riders have actually said about each provider.
     *
     * Ranking used the catalogue driver rating while the screen showed a
     * community-blended one, so the order and the numbers beside it came from
     * different sources. Optional, so a caller without a database can still
     * rank.
     */
    community?: Map<string, CommunityRating>;
    /**
     * Limits the customer stated: a maximum fare, a longest acceptable wait
     * for pickup, a latest arrival. Enforced before ranking and never waived.
     *
     * Only on this recommending path, deliberately. `quoteRides` also serves
     * the order route, which recomputes the fare server-side at booking, and a
     * limit applied there could stop a valid booking finding its own quote.
     */
    constraints?: HardConstraints | null;
  },
): {
  quotes: RideQuote[];
  trace: DecisionTrace | null;
  /**
   * Present only when the stated limits removed every option. Carries the
   * closest miss so the rider can be told what is available, which is not
   * the same as recommending it.
   */
  unmet?: NearestMiss<RideQuote> | null;
} {
  const wanted = opts.vehicle && opts.vehicle !== "any" ? opts.vehicle : null;

  const quotes = providers.flatMap((p) =>
    p.products
      .filter((prod) => !wanted || prod.vehicle === wanted)
      .map((prod): RideQuote => {
        // To the rupee, because that is what a fare is.
        //
        // A per-kilometre rate lands on amounts like ₹131.44, and no ride app
        // in India quotes paise. Rounded here rather than at the point it is
        // drawn, so the number the rider agrees to is the number they are
        // charged: rounding only the label would have shown ₹131 against a
        // ₹131.44 payment.
        const fare = Math.round((prod.basePaise + prod.perKmPaise * opts.distanceKm) / 100) * 100;
        // A coupon cannot be worth more than the ride.
        //
        // The flat offers here are ₹50 off an auto and ₹25 off a bike, which
        // is more than the whole fare on a short trip: every ride under 2.2 km
        // had at least one option priced at zero, and being the cheapest it
        // was badged BEST PRICE and ranked first, so the product gave away the
        // ride the rider was most likely to take. Clamping the total to zero
        // only hid it, because the order route charges this number.
        //
        // An offer therefore applies only when the fare can absorb it and
        // still leave the boarding charge, which is what a minimum fare is.
        // Applying it partly would be worse than not applying it at all: the
        // label states an amount, and a "₹25 off" that comes off by ₹8 is a
        // claim the bill contradicts.
        const offer =
          prod.offer && fare - prod.offer.discountPaise >= prod.basePaise ? prod.offer : null;
        const offers = offer ? [offer] : [];
        const discount = offers.reduce((s, o) => s + o.discountPaise, 0);
        return {
          provider: p.provider,
          vehicle: prod.vehicle,
          productName: prod.name,
          displayName: prod.displayName,
          farePaise: fare,
          offers,
          // No clamp: an offer that cannot be absorbed is not applied, so this
          // is always at least the boarding charge. A clamp here would hide
          // the next offer that outgrows a fare rather than refuse it.
          effectivePaise: fare - discount,
          pickupEtaMinutes: prod.pickupEta,
          rideMinutes: opts.rideMinutes,
          driverRating: prod.rating,
          // In-app order routed to the provider via ONDC — never a redirect.
          fulfillment: "in_app",
        };
      }),
  );

  // The stated limits go first, before anything is badged or ranked. An option
  // a rider has ruled out must not be labelled the best price, and must not
  // take part in the ranking where a strong rating could carry it back in.
  const hard = applyHardConstraints(
    quotes,
    (q) => ({
      pricePaise: q.effectivePaise,
      pickupMinutes: q.pickupEtaMinutes,
      etaMinutes: journeyMinutes(q),
    }),
    opts.constraints,
  );
  const valid = hard.kept;

  // Badge the genuine best price and fastest before reordering, among the
  // options still valid. Fastest means the whole journey: a ride that arrives
  // first but takes longest is not the fast one.
  const cheapest = [...valid].sort((a, b) => a.effectivePaise - b.effectivePaise)[0];
  const fastestQ = [...valid].sort((a, b) => journeyMinutes(a) - journeyMinutes(b))[0];
  if (cheapest) cheapest.badge = "BEST PRICE";
  if (fastestQ && !fastestQ.badge) fastestQ.badge = "FASTEST";

  // Order by the user's priority; defaults to balanced. The best-scoring quote
  // is presented first.
  const priority = opts.priority ?? "balanced";
  const ranked = scoreOptions(
    valid.map((q) => ({
      pricePaise: q.effectivePaise,
      // Rank on what riders said, with the weight of evidence behind it.
      ...(opts.community
        ? qualityOf(q.driverRating, opts.community.get(q.provider))
        : { rating: q.driverRating }),
      etaMinutes: journeyMinutes(q),
      quote: q,
    })),
    priority,
  );
  const ordered = ranked.map((r) => r.item.quote);

  // Two things remove a ride before scoring: the vehicle type asked for, and
  // any limit the rider stated. Counted separately, because "we have no
  // autos" and "no auto is under ₹150" are different answers.
  const totalProducts = providers.reduce((n, p) => n + p.products.length, 0);
  const vehicleExcluded = totalProducts - quotes.length;
  const exclusions = [
    ...(vehicleExcluded > 0 ? [{ rule: "vehicle_type", count: vehicleExcluded }] : []),
    ...hard.rejected,
  ];
  const excludedCount = exclusions.reduce((s, e) => s + e.count, 0);

  return {
    quotes: ordered,
    unmet: hard.nearestMiss,
    trace:
      ordered.length === 0
        ? null
        : {
            priority,
            // Rides pass no personalisation, so applied weights are the preset.
            weights: appliedWeights(priority),
            personalized: false,
            candidateCount: quotes.length,
            excludedCount,
            exclusions,
            scores: ranked.map((r) => ({
              key: r.item.quote.productName,
              pricePaise: r.item.quote.effectivePaise,
              rating: r.item.quote.driverRating,
              // The journey the ranking used. The price of time is read out of
              // these rows, and a rider paying more to shorten the whole trip
              // would be misread if only the wait were recorded.
              etaMinutes: journeyMinutes(r.item.quote),
              score: r.score,
            })),
            chosenKey: ordered[0]!.productName,
          },
  };
}

/**
 * Door to destination: the wait for pickup plus the trip itself.
 *
 * Ranking on pickup alone would call a cab that arrives in two minutes and
 * takes fifty the fast option over one that arrives in four and takes
 * twenty-five. In the simulated catalogue every provider shares one route, so
 * the trip is a constant and the ordering happens not to change; it changes
 * the moment real providers quote their own trip times.
 */
export function journeyMinutes(q: Pick<RideQuote, "pickupEtaMinutes" | "rideMinutes">): number {
  return q.pickupEtaMinutes + q.rideMinutes;
}

/**
 * What to tell a rider whose own limit left nothing to offer.
 *
 * Shared by chat and the quotes route so both surfaces say the same thing, and
 * kept as a sentence rather than the rejected quote itself: a client handed
 * the option would sooner or later draw it as bookable, which is the one thing
 * a hard constraint exists to prevent. The limit is recovered from the miss
 * (`by` is how far over it went) so nothing has to be passed in twice.
 */
export function unmetRideNote(unmet: NearestMiss<RideQuote>): string {
  const q = unmet.item;
  const rupees = (paise: number) => `₹${Math.round(paise / 100)}`;
  if (unmet.rule === "max_price") {
    return `No ride comes in under ${rupees(q.effectivePaise - unmet.by)} for this trip. The cheapest is ${rupees(q.effectivePaise)}, ${q.displayName}.`;
  }
  if (unmet.rule === "max_pickup") {
    return `No ride can pick you up within ${q.pickupEtaMinutes - unmet.by} minutes right now. The soonest is ${q.displayName}, ${q.pickupEtaMinutes} minutes away.`;
  }
  return `No ride gets you there within ${journeyMinutes(q) - unmet.by} minutes. The quickest is ${q.displayName}, ${journeyMinutes(q)} minutes.`;
}
