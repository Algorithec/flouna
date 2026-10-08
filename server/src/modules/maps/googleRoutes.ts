// Road routes from Google's Routes API.
//
// Asked for alternatives, and the shortest by distance is the one used: the
// rider and the customer are shown the same line, and the fare is priced on
// the same distance, so nobody is charged for a detour the map did not show.
//
// Returns null on anything short of a usable route, never throws. The caller
// falls back to the next provider, and an unreachable Google must not take
// ride booking down: on a venue's network that is exactly what happens.

import { decodePolyline } from "./polyline.js";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
// Only what is used. Routes API bills by the fields requested.
const FIELD_MASK = "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline";

export type GoogleRoute = {
  distanceKm: number;
  rideMinutes: number;
  geometry: [number, number][]; // [lng, lat][]
};

type Leg = { latitude: number; longitude: number };

export async function googleRoute(
  key: string,
  from: Leg,
  to: Leg,
  opts: { timeoutMs?: number } = {},
): Promise<GoogleRoute | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        origin: { location: { latLng: from } },
        destination: { location: { latLng: to } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        computeAlternativeRoutes: true,
        regionCode: "IN",
        units: "METRIC",
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      routes?: Array<{
        distanceMeters?: number;
        duration?: string;
        polyline?: { encodedPolyline?: string };
      }>;
    };

    const usable = (data.routes ?? []).filter(
      (r) =>
        typeof r.distanceMeters === "number" &&
        r.distanceMeters > 0 &&
        typeof r.duration === "string" &&
        typeof r.polyline?.encodedPolyline === "string",
    );
    if (usable.length === 0) return null;

    const shortest = usable.reduce((a, b) => (b.distanceMeters! < a.distanceMeters! ? b : a));
    const seconds = Number.parseFloat(shortest.duration!.replace(/s$/, ""));
    const geometry = decodePolyline(shortest.polyline!.encodedPolyline!);
    if (!Number.isFinite(seconds) || geometry.length < 2) return null;

    return {
      distanceKm: shortest.distanceMeters! / 1000,
      rideMinutes: Math.max(1, Math.round(seconds / 60)),
      geometry,
    };
  } catch {
    return null;
  }
}
