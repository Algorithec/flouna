import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { env } from "../src/config/env.js";

// Location search and reverse geocoding both keep an offline fallback, because
// the product has to work with no third-party keys. The guard around the call
// covered fetch throwing but stopped short of reading the body, so a 200
// carrying something that is not JSON — a captive portal's sign-in page, which
// is what a venue's wifi answers every request with — threw out of
// `response.json()` and became a 500. Ride booking went down at exactly the
// moment the fallback existed for.

const realFetch = globalThis.fetch;

/** A gateway that answers everything 200 with an HTML sign-in page. */
function captivePortal() {
  globalThis.fetch = (async () =>
    new Response("<html><body>Sign in to continue</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
}

describe("a captive portal does not take location search down", () => {
  const originalKey = env.GEOAPIFY_KEY;

  beforeEach(() => {
    // A key has to be present or the route never calls out at all.
    (env as { GEOAPIFY_KEY?: string }).GEOAPIFY_KEY = "test-key";
    captivePortal();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (env as { GEOAPIFY_KEY?: string }).GEOAPIFY_KEY = originalKey;
  });

  it("falls back to the offline places instead of answering 500", async () => {
    const { agent } = await authedAgent({ withAddress: false });
    const res = await agent.get("/api/rides/geocode?q=Charminar");
    expect(res.status).toBe(200);
    expect(res.body.places[0].name).toContain("Charminar");
  });

  it("still names a dropped pin", async () => {
    const { agent } = await authedAgent({ withAddress: false });
    const res = await agent.get("/api/rides/reverse?lat=17.3616&lng=78.4747");
    expect(res.status).toBe(200);
    expect(res.body.place).toBeTruthy();
    expect(res.body.address).toBeTruthy();
  });
});
