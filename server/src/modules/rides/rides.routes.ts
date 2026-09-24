import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { recordDecision } from "../advisor/decisionLog.service.js";
import { env } from "../../config/env.js";
import {
  quoteRides,
  quoteRidesTraced,
  unmetRideNote,
  fetchRoute,
} from "./rides.service.js";
import { withCommunityRatings, allCommunityRatings } from "../ratings/ratings.service.js";
import { adviseRide } from "../advisor/advisor.service.js";
import { recordObservation } from "../advisor/priceHistory.service.js";

export const ridesRouter = Router();
ridesRouter.use(requireAuth);

// Fallback places so location search works before a Geoapify key exists.
const DEMO_PLACES = [
  { name: "Rajiv Gandhi International Airport", area: "Shamshabad", lat: 17.2403, lng: 78.4294 },
  { name: "Hitech City", area: "Madhapur", lat: 17.4435, lng: 78.3772 },
  { name: "Charminar", area: "Old City", lat: 17.3616, lng: 78.4747 },
  { name: "Secunderabad Railway Station", area: "Secunderabad", lat: 17.4344, lng: 78.5013 },
  { name: "Banjara Hills", area: "Road No. 12", lat: 17.4126, lng: 78.4392 },
  { name: "Gachibowli Stadium", area: "Gachibowli", lat: 17.4401, lng: 78.3489 },
  { name: "Inorbit Mall", area: "Mindspace", lat: 17.4344, lng: 78.3866 },
  { name: "Osmania University", area: "Amberpet", lat: 17.4137, lng: 78.5286 },
];

// Coordinates → a human place name. Used when the rider drops a pin on the map
// and to label their live GPS position with something real instead of
// "Current location". Falls back to the nearest demo place offline.
/**
 * Ask an upstream map service, and treat any failure as "no answer".
 *
 * These routes all keep a local fallback, because the product has to work
 * without third-party keys. The fallback was only reached when the service
 * replied badly, never when the call itself threw: a blocked network, a DNS
 * failure or a throttled connection produced a 500 and took ride booking down
 * with it. That is the exact shape of a venue wifi, so it is the shape that
 * matters most.
 */
async function tryFetch(url: URL, ms = 5000): Promise<Response | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? r : null;
  } catch {
    return null;
  }
}

ridesRouter.get("/reverse", async (req, res, next) => {
  try {
    const lat = z.coerce.number().min(-90).max(90).parse(req.query.lat);
    const lng = z.coerce.number().min(-180).max(180).parse(req.query.lng);

    if (env.GEOAPIFY_KEY) {
      const url = new URL("https://api.geoapify.com/v1/geocode/reverse");
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lng));
      url.searchParams.set("limit", "1");
      url.searchParams.set("apiKey", env.GEOAPIFY_KEY);
      // Bounded wait — a hanging geocode must not freeze the address form.
      const r = await tryFetch(url);
      if (r) {
        const data = (await r.json()) as {
          features?: Array<{
            properties: {
              name?: string;
              housenumber?: string;
              street?: string;
              formatted?: string;
              address_line1?: string;
              suburb?: string;
              city?: string;
              state?: string;
              postcode?: string;
            };
          }>;
        };
        const p = data.features?.[0]?.properties;
        if (p) {
          // Structured parts let the address form auto-fill itself from a
          // dropped pin — the user should only have to type their flat/house
          // number, not re-key the whole address.
          const street = [p.housenumber, p.street].filter(Boolean).join(" ");
          return res.json({
            place: {
              name: p.name ?? p.street ?? p.suburb ?? p.formatted ?? "Pinned location",
              area: p.suburb ?? p.city ?? "",
              lat,
              lng,
            },
            address: {
              line1: street || p.address_line1 || "",
              area: p.suburb ?? "",
              city: p.city ?? "",
              state: p.state ?? "",
              pincode: p.postcode ?? "",
              formatted: p.formatted ?? "",
            },
          });
        }
      }
    }

    // Offline: name the pin after the closest known place.
    let best: (typeof DEMO_PLACES)[number] | undefined;
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of DEMO_PLACES) {
      const d = (p.lat - lat) ** 2 + (p.lng - lng) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    res.json({
      place: {
        name: "Pinned location",
        area: best ? `Near ${best.name}` : "",
        lat,
        lng,
      },
      // Same shape offline so the form can always read it; the user fills the
      // blanks in manually when we have no geocoder.
      address: {
        line1: "",
        area: best?.area ?? "",
        city: best?.area ?? "",
        state: "",
        pincode: "",
        formatted: best ? `Near ${best.name}` : "",
      },
    });
  } catch (err) {
    next(err);
  }
});

ridesRouter.get("/geocode", async (req, res, next) => {
  try {
    const q = z.string().min(2).max(120).parse(req.query.q);

    // Optional rider position — results near them rank first, so "MG Road"
    // returns the one in their city rather than another state's.
    const near = z
      .object({ lat: z.coerce.number(), lng: z.coerce.number() })
      .safeParse({ lat: req.query.lat, lng: req.query.lng });

    if (env.GEOAPIFY_KEY) {
      const url = new URL("https://api.geoapify.com/v1/geocode/autocomplete");
      url.searchParams.set("text", q);
      url.searchParams.set("filter", "countrycode:in");
      url.searchParams.set("limit", "6");
      if (near.success) {
        url.searchParams.set("bias", `proximity:${near.data.lng},${near.data.lat}`);
      }
      url.searchParams.set("apiKey", env.GEOAPIFY_KEY);
      const r = await tryFetch(url);
      if (r) {
        const data = (await r.json()) as {
          features?: Array<{
            properties: {
              name?: string;
              formatted?: string;
              suburb?: string;
              city?: string;
              lat: number;
              lon: number;
            };
          }>;
        };
        return res.json({
          places: (data.features ?? []).map((f) => ({
            name: f.properties.name ?? f.properties.formatted ?? "Unknown",
            area: f.properties.suburb ?? f.properties.city ?? "",
            lat: f.properties.lat,
            lng: f.properties.lon,
          })),
        });
      }
    }

    const needle = q.toLowerCase();
    res.json({
      places: DEMO_PLACES.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.area.toLowerCase().includes(needle),
      ).slice(0, 6),
    });
  } catch (err) {
    next(err);
  }
});

const routeQuery = z.object({
  fromLat: z.coerce.number().min(-90).max(90),
  fromLng: z.coerce.number().min(-180).max(180),
  toLat: z.coerce.number().min(-90).max(90),
  toLng: z.coerce.number().min(-180).max(180),
});

ridesRouter.get("/route", async (req, res, next) => {
  try {
    const { fromLat, fromLng, toLat, toLng } = routeQuery.parse(req.query);
    const route = await fetchRoute(fromLat, fromLng, toLat, toLng, env.ORS_KEY);
    res.json(route);
  } catch (err) {
    next(err);
  }
});

ridesRouter.get("/quotes", async (req, res, next) => {
  try {
    const parsed = z
      .object({
        distanceKm: z.coerce.number().positive().max(150),
        rideMinutes: z.coerce.number().int().positive().max(600),
        vehicle: z.enum(["bike", "auto", "cab", "any"]).default("any"),
        // Limits the rider stated in the conversation, carried here because
        // this is the only place the real trip is priced. Chat can only quote
        // a placeholder distance, so a fare limit could not honestly be
        // applied there; it was therefore dropped entirely, and a reply saying
        // "within your budget" was followed by a list that ignored it.
        // Optional: the rides screen states no limits.
        maxFarePaise: z.coerce.number().int().positive().max(10_000_000).optional(),
        maxPickupMinutes: z.coerce.number().int().positive().max(600).optional(),
      })
      .parse(req.query);
    // Fetched before ranking, not after: the order and the ratings shown
    // beside it now come from the same numbers.
    const community = await allCommunityRatings("ride");
    const {
      quotes: baseQuotes,
      trace,
      unmet,
    } = quoteRidesTraced({
      ...parsed,
      community,
      constraints: {
        maxPricePaise: parsed.maxFarePaise ?? null,
        maxPickupMinutes: parsed.maxPickupMinutes ?? null,
      },
    });
    const quotes = await withCommunityRatings("ride", baseQuotes, (q) => q.provider);
    const cheapest = quotes[0];
    if (cheapest) recordObservation("ride", cheapest.vehicle, cheapest.effectivePaise);
    // Handed to the client so a booking can be paired back to the ranking
    // that produced it.
    const decisionId = trace
      ? recordDecision({
          userId: req.userId,
          domain: "ride",
          query: `${parsed.vehicle} · ${parsed.distanceKm.toFixed(1)}km`,
          trace,
        })
      : null;
    res.json({
      quotes,
      advice: await adviseRide(cheapest?.vehicle ?? null),
      decisionId,
      // Why the list is empty, when the reason is the rider's own limit rather
      // than an absence of rides. A sentence, not the rejected option: handing
      // that back is how it ends up drawn as bookable.
      ...(unmet ? { unmetNote: unmetRideNote(unmet) } : {}),
    });
  } catch (err) {
    next(err);
  }
});
