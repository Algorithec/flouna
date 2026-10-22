// Place search and lookup through Google: Places API (New) and Geocoding.
//
// Search is autocomplete with a session token, and coordinates are fetched
// once, for the one place the rider picks. Fetching coordinates for every
// suggestion on every keystroke would spend the free quota in a day; Google
// bills an autocomplete session that ends in a single Place Details call as
// that one call, which is the design it recommends and the cheap one.
//
// Every function returns null on anything short of a usable answer and never
// throws, so the caller falls back to the next provider. The key goes in a
// header wherever the API allows it. Geocoding only accepts it in the URL,
// so that URL is never logged.

const AUTOCOMPLETE = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS = "https://places.googleapis.com/v1/places/";
const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";

export type PlaceSuggestion = { placeId: string; name: string; area: string };
export type ResolvedPlace = { name: string; area: string; lat: number; lng: number };
export type ReverseAddress = {
  place: ResolvedPlace;
  address: {
    line1: string;
    area: string;
    city: string;
    state: string;
    pincode: string;
    formatted: string;
  };
};

/** A Places ID as Google issues them; anything else never reaches a URL. */
export const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

export async function googleAutocomplete(
  key: string,
  input: string,
  opts: { near?: { lat: number; lng: number }; session?: string; timeoutMs?: number } = {},
): Promise<PlaceSuggestion[] | null> {
  try {
    const res = await fetch(AUTOCOMPLETE, {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      body: JSON.stringify({
        input,
        includedRegionCodes: ["in"],
        ...(opts.session ? { sessionToken: opts.session } : {}),
        ...(opts.near
          ? {
              locationBias: {
                circle: {
                  center: { latitude: opts.near.lat, longitude: opts.near.lng },
                  radius: 30_000,
                },
              },
            }
          : {}),
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
        };
      }>;
    };
    return (data.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId && PLACE_ID.test(p.placeId)))
      .slice(0, 6)
      .map((p) => ({
        placeId: p.placeId!,
        name: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "Unknown",
        area: p.structuredFormat?.secondaryText?.text ?? "",
      }));
  } catch {
    return null;
  }
}

export async function googlePlaceDetails(
  key: string,
  placeId: string,
  opts: { session?: string; timeoutMs?: number } = {},
): Promise<ResolvedPlace | null> {
  if (!PLACE_ID.test(placeId)) return null;
  try {
    const url = new URL(DETAILS + encodeURIComponent(placeId));
    if (opts.session) url.searchParams.set("sessionToken", opts.session);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
      headers: {
        "X-Goog-Api-Key": key,
        // Only what is used; Places bills by the fields requested.
        "X-Goog-FieldMask": "displayName,formattedAddress,location",
      },
    });
    if (!res.ok) return null;
    const d = (await res.json()) as {
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    };
    const lat = d.location?.latitude;
    const lng = d.location?.longitude;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    const name = d.displayName?.text ?? d.formattedAddress ?? "Selected place";
    const address = d.formattedAddress ?? "";
    return {
      name,
      // Google's address usually opens with the place's own name, which the
      // rider then read twice: "Gachibowli, Gachibowli, Hyderabad".
      area:
        address === name
          ? ""
          : address.startsWith(`${name}, `)
            ? address.slice(name.length + 2)
            : address,
      lat,
      lng,
    };
  } catch {
    return null;
  }
}

export async function googleReverse(
  key: string,
  lat: number,
  lng: number,
  opts: { timeoutMs?: number } = {},
): Promise<ReverseAddress | null> {
  try {
    const url = new URL(GEOCODE);
    url.searchParams.set("latlng", `${lat},${lng}`);
    url.searchParams.set("region", "in");
    url.searchParams.set("key", key);
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      results?: Array<{
        formatted_address?: string;
        address_components?: Array<{ long_name: string; types: string[] }>;
      }>;
    };
    const top = data.status === "OK" ? data.results?.[0] : undefined;
    if (!top) return null;
    const part = (type: string) =>
      top.address_components?.find((c) => c.types.includes(type))?.long_name ?? "";
    const street = [part("street_number"), part("route")].filter(Boolean).join(" ");
    const area = part("sublocality_level_1") || part("sublocality") || part("neighborhood");
    const city = part("locality") || part("administrative_area_level_2");
    return {
      place: {
        name: street || area || top.formatted_address || "Pinned location",
        area: area || city,
        lat,
        lng,
      },
      address: {
        line1: street,
        area,
        city,
        state: part("administrative_area_level_1"),
        pincode: part("postal_code"),
        formatted: top.formatted_address ?? "",
      },
    };
  } catch {
    return null;
  }
}
