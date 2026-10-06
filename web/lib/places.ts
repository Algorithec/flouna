import { api } from "@/lib/api";

// Place search, whichever provider answers.
//
// With Google configured, suggestions carry a place id and no coordinates:
// fetching coordinates for every suggestion on every keystroke would spend
// the free quota in a day. The coordinates of the one the rider picks are
// fetched once. Every other provider returns coordinates with the suggestion,
// and then nothing more is asked for. Callers do not need to know which.

export type Suggestion = {
  name: string;
  area: string;
  lat?: number;
  lng?: number;
  placeId?: string;
};

export type ResolvedPlace = { name: string; area: string; lat: number; lng: number };

/**
 * One token per use of a search box. Google bills the keystrokes of a session
 * and the lookup that ends it as that one lookup, so the token is reused for
 * a whole search and replaced once a place is chosen.
 */
export function newSearchSession(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Plain http on a LAN has no randomUUID; a v4-shaped id is all that is needed.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** A stable list key; Google suggestions have an id and no coordinates. */
export function suggestionKey(s: Suggestion): string {
  return s.placeId ?? `${s.name}-${s.lat}-${s.lng}`;
}

export async function searchPlaces(
  q: string,
  opts: { near?: { lat: number; lng: number } | null; session?: string } = {},
): Promise<Suggestion[]> {
  const params = new URLSearchParams({ q });
  if (opts.near) {
    params.set("lat", String(opts.near.lat));
    params.set("lng", String(opts.near.lng));
  }
  if (opts.session) params.set("session", opts.session);
  const d = await api<{ places: Suggestion[] }>(`/api/rides/geocode?${params}`);
  return d.places;
}

/**
 * Coordinates for a suggestion: its own, or one lookup. Null when neither is
 * available, so a caller never puts a pin at 0,0.
 */
export async function resolvePlace(
  s: Suggestion,
  session?: string,
): Promise<ResolvedPlace | null> {
  if (typeof s.lat === "number" && typeof s.lng === "number") {
    return { name: s.name, area: s.area, lat: s.lat, lng: s.lng };
  }
  if (!s.placeId) return null;
  const params = new URLSearchParams({ id: s.placeId });
  if (session) params.set("session", session);
  try {
    const d = await api<{ place: ResolvedPlace }>(`/api/rides/place?${params}`);
    return d.place;
  } catch {
    return null;
  }
}
