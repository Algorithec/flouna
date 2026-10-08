import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
});

import { authedAgent } from "./helpers.js";
import { quoteRides } from "../src/modules/rides/rides.service.js";

// The fare a rider is shown has to be the fare they are charged.
//
// A ride is priced from the route distance twice: when the screen asks for the
// route, and again when the order is placed, because the server never trusts a
// distance from the client. OpenRouteService gave the same answer both times.
// Google routes with live traffic and its shortest alternative can change
// between the two calls, so the booked fare could differ from the one on the
// review button.

const EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const TRIP = { pickupLat: 17.4435, pickupLng: 78.3772, dropLat: 17.2403, dropLng: 78.4294 };

afterEach(async () => {
  vi.unstubAllGlobals();
  const { clearRouteCache } = await import("../src/modules/rides/rides.service.js");
  clearRouteCache();
});

/** Google answers with a different shortest route on each call. */
function shiftingGoogle(distancesKm: number[]) {
  let call = 0;
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("routes.googleapis.com")) return real(input, init);
      const km = distancesKm[Math.min(call++, distancesKm.length - 1)]!;
      return new Response(
        JSON.stringify({
          routes: [{ distanceMeters: km * 1000, duration: "1800s", polyline: { encodedPolyline: EXAMPLE } }],
        }),
        { status: 200 },
      );
    }),
  );
}

describe("pricing the same trip twice", () => {
  it("charges the fare the rider saw, even if Google's route has since changed", async () => {
    shiftingGoogle([26.5, 31]);
    const { agent } = await authedAgent();

    // What the booking card does: route, then the fare for that distance.
    const route = await agent
      .get(
        `/api/rides/route?fromLat=${TRIP.pickupLat}&fromLng=${TRIP.pickupLng}&toLat=${TRIP.dropLat}&toLng=${TRIP.dropLng}`,
      )
      .expect(200);
    expect(route.body.distanceKm).toBe(26.5);
    const shown = quoteRides({ distanceKm: route.body.distanceKm, rideMinutes: route.body.rideMinutes })
      .find((q) => q.productName === "ONDC Cab")!;

    const order = await agent
      .post("/api/orders")
      .send({ domain: "ride", provider: "ondc", productName: "ONDC Cab", pickup: "A", drop: "B", ...TRIP })
      .expect(201);

    expect(order.body.order.amount).toBe(shown.effectivePaise);
  });
});
