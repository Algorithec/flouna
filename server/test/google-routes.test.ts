import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePolyline } from "../src/modules/maps/polyline.js";
import { googleRoute } from "../src/modules/maps/googleRoutes.js";
import { clearRouteCache, fetchRoute } from "../src/modules/rides/rides.service.js";

// Google routes, and what happens when Google is not there.
//
// No key is needed to run these: Google is faked at the fetch boundary with
// the response shape the Routes API documents. What is being tested is ours,
// not theirs — that the shortest alternative is chosen so the rider and the
// customer see the line the fare was priced on, and that any failure falls
// through instead of taking ride booking down.

const FROM = { latitude: 17.4435, longitude: 78.3772 };
const TO = { latitude: 17.2403, longitude: 78.4294 };

// Google's own worked example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
const EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

function fakeGoogle(response: unknown, status = 200) {
  const seen: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify(response), { status });
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Routes are remembered for ten minutes; each test fakes its own answer.
  clearRouteCache();
});

describe("decoding Google's polylines", () => {
  it("decodes Google's documented example to [lng, lat] pairs", () => {
    expect(decodePolyline(EXAMPLE)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it("refuses a truncated polyline rather than inventing a point", () => {
    expect(() => decodePolyline("_p~iF~ps|U_ul")).toThrow();
  });
});

describe("choosing a Google route", () => {
  it("takes the shortest alternative, so the map and the fare agree", async () => {
    fakeGoogle({
      routes: [
        { distanceMeters: 31_000, duration: "1500s", polyline: { encodedPolyline: EXAMPLE } },
        { distanceMeters: 26_500, duration: "1800s", polyline: { encodedPolyline: EXAMPLE } },
        { distanceMeters: 29_000, duration: "1400s", polyline: { encodedPolyline: EXAMPLE } },
      ],
    });
    const r = await googleRoute("key", FROM, TO);
    expect(r?.distanceKm).toBe(26.5);
    expect(r?.rideMinutes).toBe(30);
    expect(r?.geometry).toHaveLength(3);
  });

  it("asks for alternatives and only the fields it uses", async () => {
    const seen = fakeGoogle({
      routes: [{ distanceMeters: 1000, duration: "120s", polyline: { encodedPolyline: EXAMPLE } }],
    });
    await googleRoute("secret-key", FROM, TO);

    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("secret-key");
    // The Routes API bills by the fields requested; anything extra is money.
    expect(headers["X-Goog-FieldMask"]).toBe(
      "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
    );
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.computeAlternativeRoutes).toBe(true);
    expect(body.origin.location.latLng).toEqual(FROM);
    // The key goes in a header, never the URL, where proxies and logs keep it.
    expect(seen[0]!.url).not.toContain("secret-key");
  });

  it.each([
    ["an error status", { error: { code: 403 } }, 403],
    ["no routes", { routes: [] }, 200],
    ["a route with no geometry", { routes: [{ distanceMeters: 1000, duration: "60s" }] }, 200],
    ["a zero-length route", { routes: [{ distanceMeters: 0, duration: "0s", polyline: { encodedPolyline: EXAMPLE } }] }, 200],
  ])("gives up on %s instead of returning a broken route", async (_, body, status) => {
    fakeGoogle(body, status);
    expect(await googleRoute("key", FROM, TO)).toBeNull();
  });

  it("gives up when Google cannot be reached at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await googleRoute("key", FROM, TO)).toBeNull();
  });
});

describe("the route the app uses", () => {
  it("comes from Google when a key is configured", async () => {
    fakeGoogle({
      routes: [{ distanceMeters: 26_500, duration: "1800s", polyline: { encodedPolyline: EXAMPLE } }],
    });
    const r = await fetchRoute(FROM.latitude, FROM.longitude, TO.latitude, TO.longitude, undefined, "key");
    expect(r.distanceKm).toBe(26.5);
  });

  it("falls back to the offline estimate when Google is down, rather than failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const r = await fetchRoute(FROM.latitude, FROM.longitude, TO.latitude, TO.longitude, undefined, "key");
    expect(r.distanceKm).toBeGreaterThan(0);
    expect(r.geometry).toHaveLength(2); // the straight-line fallback
  });

  it("never calls Google without a key", async () => {
    const seen = fakeGoogle({});
    await fetchRoute(FROM.latitude, FROM.longitude, TO.latitude, TO.longitude);
    expect(seen.some((s) => s.url.includes("googleapis"))).toBe(false);
  });
});
