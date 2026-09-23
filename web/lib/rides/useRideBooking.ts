"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { RideQuote } from "@/components/chat/types";
import type { Advice } from "@/components/ui/AdviceBanner";

// One booking machine, two surfaces.
//
// The rides screen and the booking card inside the chat do the same job:
// resolve two points, price the trip, and place the order. Written twice they
// would disagree the first time either changed, and the disagreement would be
// about money.
//
// So the whole flow lives here and both render it. What stays with each screen
// is only layout and the things one has and the other does not: saved-address
// management and split-with-friends belong to the rides page, and the chat card
// has no business growing its own copy of them.
//
// confirm() returns the order id rather than navigating anywhere. The page
// pushes to the payment route; the chat card opens payment in the thread. A
// hook that called router.push would have made the second one impossible.

export type Place = { name: string; area: string; lat: number; lng: number };

export type RouteInfo = {
  distanceKm: number;
  rideMinutes: number;
  geometry: [number, number][] | null;
};

export const VEHICLES = ["any", "bike", "auto", "cab"] as const;
export type Vehicle = (typeof VEHICLES)[number];

export type RideBooking = ReturnType<typeof useRideBooking>;

/** Random enough that two devices cannot collide on one. */
function newAttemptKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useRideBooking(opts: {
  /** Destination carried in from chat, geocoded on mount. */
  initialDrop?: string | null;
  initialVehicle?: Vehicle;
  /** ISO time for a later ride, or null to ride now. */
  initialScheduledAt?: string | null;
  /** Skips the live-position read. The chat card sets this until it is opened. */
  enabled?: boolean;
  /**
   * The ranking this booking came from, when it started as a recommendation.
   *
   * Sent with the order so the ride taken is paired with the ride offered.
   * Absent when the rider opened the rides screen directly, which came from
   * no ranking.
   */
  decisionId?: string;
} = {}) {
  const enabled = opts.enabled !== false;

  const [pickup, setPickup] = useState<Place | null>(null);
  const [drop, setDrop] = useState<Place | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle>(opts.initialVehicle ?? "any");
  const [quotes, setQuotes] = useState<RideQuote[]>([]);
  /**
   * The ranking these fares came from.
   *
   * The booking card re-prices over the real route, so this, not the one the
   * chat reply carried, is the list the rider actually chose from. Replaced
   * whenever the quotes are, so a booking is never paired to a ranking of
   * fares that are no longer on screen.
   */
  const [quoteDecisionId, setQuoteDecisionId] = useState<string | null>(null);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [selected, setSelected] = useState<RideQuote | null>(null);
  const [scheduledAt, setScheduledAt] = useState<string | null>(
    opts.initialScheduledAt ?? null,
  );
  const [saved, setSaved] = useState<Place[]>([]);
  const [shareLocation, setShareLocation] = useState<boolean | null>(null);
  const [locating, setLocating] = useState(false);
  const [picking, setPicking] = useState<"pickup" | "drop" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // One key per booking attempt.
  //
  // A double-tap, or a connection that retried the request, sends the same
  // booking twice, and the server has no other way to tell that from somebody
  // deliberately booking the same trip again. Held in a ref so both taps carry
  // the same key, and replaced after a booking succeeds so the next trip is a
  // new attempt rather than a repeat of the last one.
  const attemptKey = useRef<string>(newAttemptKey());

  /** Turns a coordinate into a named place, falling back to the coordinate. */
  const nameFor = useCallback(
    async (lat: number, lng: number, fallback: Place): Promise<Place> => {
      try {
        const d = await api<{ place: Place }>(`/api/rides/reverse?lat=${lat}&lng=${lng}`);
        return d.place ? { ...d.place, area: d.place.area || fallback.area } : fallback;
      } catch {
        // A missing geocoder must not stop a booking: the coordinates are what
        // the server prices from, and the name is only for the person reading.
        return fallback;
      }
    },
    [],
  );

  /** Reads the device position on demand. */
  const detectPickup = useCallback(() => {
    if (!navigator.geolocation) {
      setError("This browser cannot share your location. Type your pickup below.");
      return;
    }
    setError("");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setPickup(
          await nameFor(lat, lng, {
            name: "Current location",
            area: "Your live location",
            lat,
            lng,
          }),
        );
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        // Silently doing nothing is the worst answer here: the rider taps a
        // control, the map does not move, and there is no way to tell a
        // refused permission from a slow fix or a broken button. Say which,
        // and say what they can do instead.
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location is blocked for this site. Allow it, or type your pickup below."
            : "Could not get your location just now. Type your pickup below.",
        );
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  }, [nameFor]);

  /** Assigns whichever endpoint is currently being picked on the map. */
  const pickOnMap = useCallback(
    async (p: { lat: number; lng: number }) => {
      const target = picking;
      if (!target) return;
      setPicking(null);
      const place = await nameFor(p.lat, p.lng, {
        name: "Pinned location",
        area: `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
        lat: p.lat,
        lng: p.lng,
      });
      if (target === "pickup") setPickup(place);
      else setDrop(place);
    },
    [picking, nameFor],
  );

  // Saved addresses that carry coordinates, offered as suggestions.
  useEffect(() => {
    if (!enabled) return;
    api<{ addresses: { label: string; line1: string; lat?: number | null; lng?: number | null }[] }>(
      "/api/users/addresses",
    )
      .then((d) =>
        setSaved(
          d.addresses
            .filter((a) => a.lat != null && a.lng != null)
            .map((a) => ({
              name: a.label,
              area: a.line1,
              lat: a.lat as number,
              lng: a.lng as number,
            })),
        ),
      )
      .catch(() => setSaved([]));
  }, [enabled]);

  // Share My Location gates the automatic read below. Defaults to on when the
  // request fails, matching the server default.
  useEffect(() => {
    if (!enabled) return;
    api<{ shareLocation: boolean }>("/api/users/preferences")
      .then((p) => setShareLocation(p.shareLocation))
      .catch(() => setShareLocation(true));
  }, [enabled]);

  // Auto-fill pickup once, if allowed. Deferred a tick so the flag is not set
  // synchronously inside the effect and cannot land after a fast fix.
  useEffect(() => {
    if (!enabled || shareLocation !== true || !navigator.geolocation) return;
    let cancelled = false;
    const start = setTimeout(() => {
      if (cancelled) return;
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          if (cancelled) return;
          const { latitude: lat, longitude: lng } = pos.coords;
          const place = await nameFor(lat, lng, {
            name: "Current location",
            area: "Your live location",
            lat,
            lng,
          });
          if (cancelled) return;
          // Never overrides a pickup already chosen, e.g. carried from chat.
          setPickup((prev) => prev ?? place);
          setLocating(false);
        },
        () => !cancelled && setLocating(false),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(start);
    };
  }, [enabled, shareLocation, nameFor]);

  // Resolve a destination carried in from chat, so the card opens ready.
  //
  // "Home" is a saved address before it is a place on a map, so that is tried
  // first. Geocoding the word "home" returns somebody else's neighbourhood.
  const initialDrop = opts.initialDrop ?? null;
  useEffect(() => {
    if (!enabled || !initialDrop) return;
    let cancelled = false;

    async function resolve(query: string) {
      const savedWords = ["home", "work", "office", "house"];
      if (savedWords.some((w) => query.toLowerCase().includes(w))) {
        try {
          const { addresses } = await api<{
            addresses: {
              label: string;
              line1: string;
              city: string;
              lat: number | null;
              lng: number | null;
            }[];
          }>("/api/users/addresses");
          const match =
            addresses.find((a) => query.toLowerCase().includes(a.label.toLowerCase())) ??
            addresses[0];
          if (match) {
            if (match.lat != null && match.lng != null) {
              if (!cancelled) {
                setDrop((prev) => prev ?? {
                  name: match.label,
                  area: `${match.line1}, ${match.city}`,
                  lat: match.lat as number,
                  lng: match.lng as number,
                });
              }
              return;
            }
            // Saved, but without coordinates: geocode its text instead.
            query = `${match.line1} ${match.city}`;
          }
        } catch {
          // Falls through to a plain geocode.
        }
      }
      try {
        const d = await api<{ places: Place[] }>(
          `/api/rides/geocode?q=${encodeURIComponent(query)}`,
        );
        if (!cancelled && d.places[0]) setDrop((prev) => prev ?? d.places[0]!);
      } catch {
        // Leaves drop empty so the person can type it, rather than guessing.
      }
    }

    void resolve(initialDrop);
    return () => {
      cancelled = true;
    };
  }, [enabled, initialDrop]);

  // Clearing either endpoint invalidates everything derived from the pair.
  // Without this a stale route and its quotes survive, and the card would
  // offer a price for a trip that is no longer described.
  const bothSet = Boolean(pickup && drop);
  const [hadBoth, setHadBoth] = useState(bothSet);
  if (hadBoth !== bothSet) {
    setHadBoth(bothSet);
    if (!bothSet) {
      setRoute(null);
      setQuotes([]);
      setSelected(null);
    }
  }

  // Route, then quotes. Both are derived, so neither is stored by the caller.
  useEffect(() => {
    if (!pickup || !drop) return;
    let cancelled = false;
    api<RouteInfo>(
      `/api/rides/route?fromLat=${pickup.lat}&fromLng=${pickup.lng}&toLat=${drop.lat}&toLng=${drop.lng}`,
    )
      .then((r) => !cancelled && setRoute(r))
      .catch(() => !cancelled && setError("Could not calculate the route"));
    return () => {
      cancelled = true;
    };
  }, [pickup, drop]);

  const loadQuotes = useCallback(() => {
    if (!route) return;
    api<{ quotes: RideQuote[]; advice?: Advice; decisionId?: string | null }>(
      `/api/rides/quotes?distanceKm=${route.distanceKm.toFixed(2)}&rideMinutes=${route.rideMinutes}&vehicle=${vehicle}`,
    )
      .then((d) => {
        setQuotes(d.quotes);
        setAdvice(d.advice ?? null);
        setSelected(d.quotes[0] ?? null);
        setQuoteDecisionId(d.decisionId ?? null);
      })
      .catch(() => {
        setError("Could not fetch ride options");
        setQuoteDecisionId(null);
      });
  }, [route, vehicle]);
  useEffect(loadQuotes, [loadQuotes]);

  const mapPoints = useMemo(
    () => ({
      pickup: pickup ? { lat: pickup.lat, lng: pickup.lng } : null,
      drop: drop ? { lat: drop.lat, lng: drop.lng } : null,
    }),
    [pickup, drop],
  );

  /**
   * Places the order and returns its id.
   *
   * Deliberately does not navigate. The rides page pushes to the payment
   * route; the chat card opens payment in the thread. Only distances and
   * coordinates are sent, never a fare: the server recomputes the price, so
   * nothing here can move what is charged.
   */
  async function confirm(): Promise<string | null> {
    if (!selected || !pickup || !drop || !route) return null;
    setBusy(true);
    setError("");
    try {
      const d = await api<{ order: { id: string } }>("/api/orders", {
        method: "POST",
        headers: { "Idempotency-Key": attemptKey.current },
        json: {
          domain: "ride",
          // The ranking the chosen fare came from. Prefer the one behind the
          // fares on screen; fall back to the chat's ranking when the quotes
          // route recorded none.
          ...(quoteDecisionId || opts.decisionId
            ? { decisionId: quoteDecisionId ?? opts.decisionId }
            : {}),
          provider: selected.provider,
          productName: selected.productName,
          pickup: pickup.name,
          drop: drop.name,
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          dropLat: drop.lat,
          dropLng: drop.lng,
          ...(scheduledAt ? { scheduledAt } : {}),
        },
      });
      // Booked. The next one is a new decision, not a retry of this.
      attemptKey.current = newAttemptKey();
      return d.order.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not book the ride");
      return null;
    } finally {
      setBusy(false);
    }
  }

  return {
    pickup, setPickup,
    drop, setDrop,
    route,
    vehicle, setVehicle,
    quotes, advice,
    selected, setSelected,
    scheduledAt, setScheduledAt,
    saved,
    shareLocation,
    locating,
    picking, setPicking,
    error, setError,
    busy,
    mapPoints,
    detectPickup,
    pickOnMap,
    reloadQuotes: loadQuotes,
    confirm,
    /** Everything needed is in place and a trip can be booked. */
    ready: Boolean(selected && pickup && drop && route),
  };
}
