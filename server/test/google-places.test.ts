import { afterEach, describe, expect, it, vi } from "vitest";

// Google has to be configured before the app, and so the env module, loads.
vi.hoisted(() => {
  process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
});

import { authedAgent } from "./helpers.js";

// Place search through Google, and the fallback when Google is not there.
//
// Faked at the fetch boundary with the documented response shapes, so no key
// or network is needed. What is under test is ours: suggestions are cheap
// (no coordinates per keystroke), the one picked is looked up once, the key
// never leaves in a URL we control, and a dead Google falls back instead of
// breaking the search box.

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const PLACE_ID = "ChIJLfySpTOuEmsRsc_JfJtljdc";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeGoogle(handler: Handler) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("googleapis.com")) return real(input, init);
      seen.push({ url, init });
      return handler(url, init);
    }),
  );
  return seen;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("searching for a place", () => {
  it("returns suggestions without coordinates, and forwards the session", async () => {
    const seen = fakeGoogle(() =>
      json({
        suggestions: [
          {
            placePrediction: {
              placeId: PLACE_ID,
              text: { text: "Hitech City, Hyderabad" },
              structuredFormat: {
                mainText: { text: "Hitech City" },
                secondaryText: { text: "Hyderabad, Telangana" },
              },
            },
          },
        ],
      }),
    );
    const { agent } = await authedAgent();
    const res = await agent
      .get(`/api/rides/geocode?q=hitech&lat=17.44&lng=78.38&session=${SESSION}`)
      .expect(200);

    expect(res.body.places).toEqual([
      { placeId: PLACE_ID, name: "Hitech City", area: "Hyderabad, Telangana" },
    ]);
    const body = JSON.parse(String(seen[0]!.init!.body));
    expect(body.sessionToken).toBe(SESSION);
    expect(body.includedRegionCodes).toEqual(["in"]);
    expect(body.locationBias.circle.center).toEqual({ latitude: 17.44, longitude: 78.38 });
    // The key travels in a header, not in the request a proxy might log.
    expect(seen[0]!.url).not.toContain("test-google-key");
    expect(body).not.toHaveProperty("key");
  });

  it("falls back to the offline places when Google cannot be reached", async () => {
    fakeGoogle(() => {
      throw new TypeError("fetch failed");
    });
    const { agent } = await authedAgent();
    const res = await agent.get("/api/rides/geocode?q=gachibowli").expect(200);
    expect(res.body.places.length).toBeGreaterThan(0);
    // Offline places carry coordinates, so the client needs no second call.
    expect(typeof res.body.places[0].lat).toBe("number");
  });

  it("ignores a session token that is not a UUID rather than sending it on", async () => {
    const seen = fakeGoogle(() => json({ suggestions: [] }));
    const { agent } = await authedAgent();
    await agent.get("/api/rides/geocode?q=hitech&session=not-a-uuid").expect(200);
    expect(JSON.parse(String(seen[0]!.init!.body))).not.toHaveProperty("sessionToken");
  });
});

describe("looking up the place that was picked", () => {
  it("returns its coordinates, asking only for the fields used", async () => {
    const seen = fakeGoogle(() =>
      json({
        displayName: { text: "Hitech City" },
        formattedAddress: "Hitech City, Hyderabad, Telangana",
        location: { latitude: 17.4435, longitude: 78.3772 },
      }),
    );
    const { agent } = await authedAgent();
    const res = await agent.get(`/api/rides/place?id=${PLACE_ID}&session=${SESSION}`).expect(200);

    expect(res.body.place).toEqual({
      name: "Hitech City",
      area: "Hitech City, Hyderabad, Telangana",
      lat: 17.4435,
      lng: 78.3772,
    });
    const headers = seen[0]!.init!.headers as Record<string, string>;
    expect(headers["X-Goog-FieldMask"]).toBe("displayName,formattedAddress,location");
    expect(seen[0]!.url).toContain(`sessionToken=${SESSION}`);
    expect(seen[0]!.url).not.toContain("test-google-key");
  });

  it("refuses an id that is not a place id, before it reaches a URL", async () => {
    const seen = fakeGoogle(() => json({}));
    const { agent } = await authedAgent();
    await agent.get("/api/rides/place?id=..%2F..%2Fplaces%3Fx%3D1").expect(400);
    expect(seen).toHaveLength(0);
  });

  it("says so when Google has no coordinates, instead of inventing them", async () => {
    fakeGoogle(() => json({ displayName: { text: "Nowhere" } }));
    const { agent } = await authedAgent();
    await agent.get(`/api/rides/place?id=${PLACE_ID}`).expect(502);
  });
});

describe("naming a dropped pin", () => {
  it("fills the address from Google's components", async () => {
    fakeGoogle(() =>
      json({
        status: "OK",
        results: [
          {
            formatted_address: "12 Cyber Towers Rd, Hitech City, Hyderabad, Telangana 500081",
            address_components: [
              { long_name: "12", types: ["street_number"] },
              { long_name: "Cyber Towers Rd", types: ["route"] },
              { long_name: "Hitech City", types: ["sublocality_level_1", "sublocality"] },
              { long_name: "Hyderabad", types: ["locality"] },
              { long_name: "Telangana", types: ["administrative_area_level_1"] },
              { long_name: "500081", types: ["postal_code"] },
            ],
          },
        ],
      }),
    );
    const { agent } = await authedAgent();
    const res = await agent.get("/api/rides/reverse?lat=17.4435&lng=78.3772").expect(200);
    expect(res.body.address).toEqual({
      line1: "12 Cyber Towers Rd",
      area: "Hitech City",
      city: "Hyderabad",
      state: "Telangana",
      pincode: "500081",
      formatted: "12 Cyber Towers Rd, Hitech City, Hyderabad, Telangana 500081",
    });
    expect(res.body.place.lat).toBe(17.4435);
  });

  it("falls back to the nearest known place when Google refuses", async () => {
    fakeGoogle(() => json({ status: "REQUEST_DENIED", results: [] }));
    const { agent } = await authedAgent();
    const res = await agent.get("/api/rides/reverse?lat=17.4435&lng=78.3772").expect(200);
    expect(res.body.place.name).toBe("Pinned location");
    expect(res.body.place.area).toMatch(/^Near /);
  });
});
