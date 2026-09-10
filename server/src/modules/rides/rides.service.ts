// Simulated ride-provider quotes (Uber/Ola/Rapido/ONDC). Same adapter shape
// real provider/ONDC-mobility integrations will implement later.
import { qualityOf, type CommunityRating } from "../ratings/blend.js";
import {
  scoreOptions,
  appliedWeights,
  type Priority,
  type DecisionTrace,
} from "../advisor/scoring.js";

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
export async function fetchRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  orsKey?: string,
): Promise<RouteResult> {
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
  },
): {
  quotes: RideQuote[];
  trace: DecisionTrace | null;
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
        const offers = prod.offer ? [prod.offer] : [];
        const discount = offers.reduce((s, o) => s + o.discountPaise, 0);
        return {
          provider: p.provider,
          vehicle: prod.vehicle,
          productName: prod.name,
          displayName: prod.displayName,
          farePaise: fare,
          offers,
          effectivePaise: Math.max(0, fare - discount),
          pickupEtaMinutes: prod.pickupEta,
          rideMinutes: opts.rideMinutes,
          driverRating: prod.rating,
          // In-app order routed to the provider via ONDC — never a redirect.
          fulfillment: "in_app",
        };
      }),
  );

  // Badge the genuine best price and fastest before reordering.
  const cheapest = [...quotes].sort((a, b) => a.effectivePaise - b.effectivePaise)[0];
  const fastestQ = [...quotes].sort((a, b) => a.pickupEtaMinutes - b.pickupEtaMinutes)[0];
  if (cheapest) cheapest.badge = "BEST PRICE";
  if (fastestQ && !fastestQ.badge) fastestQ.badge = "FASTEST";

  // Order by the user's priority (driver rating, fare, or pickup ETA weighted);
  // defaults to balanced. The best-scoring quote is presented first.
  const priority = opts.priority ?? "balanced";
  const ranked = scoreOptions(
    quotes.map((q) => ({
      pricePaise: q.effectivePaise,
      // Rank on what riders said, with the weight of evidence behind it.
      ...(opts.community
        ? qualityOf(q.driverRating, opts.community.get(q.provider))
        : { rating: q.driverRating }),
      etaMinutes: q.pickupEtaMinutes,
      quote: q,
    })),
    priority,
  );
  const ordered = ranked.map((r) => r.item.quote);

  // Vehicle filtering is the only rule that removes a ride option before
  // scoring; everything configured for that type is quoted.
  const totalProducts = providers.reduce((n, p) => n + p.products.length, 0);
  const excludedCount = totalProducts - quotes.length;

  return {
    quotes: ordered,
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
            exclusions: excludedCount > 0 ? [{ rule: "vehicle_type", count: excludedCount }] : [],
            scores: ranked.map((r) => ({
              key: r.item.quote.productName,
              pricePaise: r.item.quote.effectivePaise,
              rating: r.item.quote.driverRating,
              etaMinutes: r.item.quote.pickupEtaMinutes,
              score: r.score,
            })),
            chosenKey: ordered[0]!.productName,
          },
  };
}
