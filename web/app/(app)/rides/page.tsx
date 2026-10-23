"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search,
  MapPin,
  Star,
  Clock,
  CircleDot,
  Plus,
  LocateFixed,
  Loader2,
  Users,
  Bike,
  Car,
  CarTaxiFront,
} from "lucide-react";
import { api } from "@/lib/api";
import { newSearchSession, resolvePlace, searchPlaces, suggestionKey, type Suggestion } from "@/lib/places";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AdviceBanner, type Advice } from "@/components/ui/AdviceBanner";
import { OndcRideOffers } from "@/components/rides/OndcRideOffers";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";
import type { RideQuote } from "@/components/chat/types";
import { FlounaLogo } from "@/components/brand/FlounaLogo";

const RideMap = dynamic(
  () => import("@/components/rides/RideMap").then((m) => m.RideMap),
  {
    ssr: false,
    loading: () => (
      <div className="size-full min-h-[260px] animate-pulse bg-beige/50" />
    ),
  },
);

type Place = { name: string; area: string; lat: number; lng: number };
type RouteInfo = {
  distanceKm: number;
  rideMinutes: number;
  geometry: [number, number][];
};

const VEHICLES = ["any", "bike", "auto", "cab"] as const;

/** Random enough that two devices cannot collide on one. */
function newAttemptKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Seat counts are a fixed fact of the vehicle type, not order data — safe to
// look up client-side rather than round-trip it from the quote.
const SEATS: Record<string, number> = { bike: 1, auto: 3, cab: 4 };
const VEHICLE_ICON: Record<string, typeof Bike> = {
  bike: Bike,
  auto: CarTaxiFront,
  cab: Car,
};

function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function PlaceSearch({
  label,
  icon,
  value,
  onSelect,
  near,
  action,
}: {
  label: string;
  icon?: React.ReactNode;
  value: Place | null;
  onSelect: (p: Place | null) => void;
  // Rider's live position — biases results to places near them.
  near?: { lat: number; lng: number } | null;
  // Small action rendered inside the field (e.g. re-detect GPS, clear).
  action?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [places, setPlaces] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  // One search session per use of this box; replaced once a place is chosen.
  const session = useRef(newSearchSession());
  const input = useRef<HTMLInputElement>(null);
  // The list opens only while the field has focus. A search that came back
  // after the rider had moved on used to open it over the next field, where
  // it stayed: nothing but choosing a place closed it.
  const focused = useRef(false);

  useEffect(() => {
    let current = true;
    const short = text.length < 2;
    const t = setTimeout(
      () => {
        if (short) {
          setPlaces([]);
          return;
        }
        searchPlaces(text, { near, session: session.current })
          .then((found) => {
            if (!current) return; // a later search has replaced this one
            setPlaces(found);
            if (focused.current) setOpen(true);
          })
          .catch(() => current && setPlaces([]));
      },
      short ? 0 : 250,
    );
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [text, near]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-[14px] border border-line bg-card px-3 py-2.5">
        {icon ?? <Search size={15} className="shrink-0 text-cocoa/50" />}
        <input
          value={
            value ? `${value.name}${value.area ? `, ${value.area}` : ""}` : text
          }
          onChange={(e) => {
            onSelect(null);
            setText(e.target.value);
          }}
          ref={input}
          onFocus={() => {
            focused.current = true;
            if (places.length > 0) setOpen(true);
          }}
          onBlur={() => {
            focused.current = false;
            setOpen(false);
          }}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          placeholder={label}
          className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-cocoa/50"
        />
        {action}
      </div>
      {open && places.length > 0 && !value && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-[14px] border border-line bg-card shadow-card">
          {places.map((p) => (
            <button
              key={suggestionKey(p)}
              // Keeps the focus in the field, so its blur cannot close the
              // list before this choice lands.
              onPointerDown={(e) => e.preventDefault()}
              onClick={async () => {
                setOpen(false);
                setText("");
                input.current?.blur();
                // A Google suggestion has no coordinates until it is chosen.
                const place = await resolvePlace(p, session.current);
                session.current = newSearchSession();
                if (place) onSelect(place);
              }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] hover:bg-beige/40"
            >
              <MapPin size={14} className="shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">
                  {p.name}
                </span>
                <span className="block truncate text-[11px] text-cocoa">
                  {p.area}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RidesPage() {
  return (
    <Suspense fallback={null}>
      <RidesInner />
    </Suspense>
  );
}

function RidesInner() {
  const router = useRouter();
  const search = useSearchParams();
  const { t } = useI18n();
  const [pickup, setPickup] = useState<Place | null>(null);
  const [drop, setDrop] = useState<Place | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  // Pre-select the vehicle carried from chat (?vehicle=cab), else "any".
  const [vehicle, setVehicle] = useState<(typeof VEHICLES)[number]>(() => {
    const v = search.get("vehicle");
    return v && (VEHICLES as readonly string[]).includes(v)
      ? (v as (typeof VEHICLES)[number])
      : "any";
  });
  const [quotes, setQuotes] = useState<RideQuote[]>([]);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [selected, setSelected] = useState<RideQuote | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Ride scheduling — pre-filled when chat carried "at 10pm" (?at=ISO), and
  // adjustable here. null = ride now.
  const [scheduledAt, setScheduledAt] = useState<string | null>(() => {
    const at = search.get("at");
    return at && !Number.isNaN(Date.parse(at)) && Date.parse(at) > Date.now()
      ? new Date(at).toISOString()
      : null;
  });
  // Earliest schedulable slot (~10 min out), in datetime-local form. Captured
  // once on mount — the server re-validates the real lead time anyway.
  const [minSchedule] = useState(() =>
    new Date(Date.now() + 10 * 60_000 - new Date().getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16),
  );
  // Auto-detect is off until the Share My Location preference says otherwise,
  // so "locating" starts false and the effect below turns it on if it runs.
  const [locating, setLocating] = useState(false);
  // null while the preference is loading — the effect waits rather than reading
  // the device position and then discovering it wasn't allowed to.
  const [shareLocation, setShareLocation] = useState<boolean | null>(null);
  // "Suggested locations" (Figma) — the user's saved places with coordinates.
  const [saved, setSaved] = useState<Place[]>([]);
  // Which endpoint the next map tap sets (null = tapping does nothing).
  const [picking, setPicking] = useState<"pickup" | "drop" | null>(null);
  // One key per booking attempt; replaced once a booking succeeds.
  const attemptKey = useRef<string>(newAttemptKey());

  // Detect (or re-detect) the rider's live position on demand. The auto-detect
  // on mount used to be the only chance to get this — if it failed or the
  // rider moved, there was no way to ask again.
  const detectPickup = useCallback(() => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        let place: Place = {
          name: "Current location",
          area: "Your live location",
          lat,
          lng,
        };
        try {
          const d = await api<{ place: Place }>(
            `/api/rides/reverse?lat=${lat}&lng=${lng}`,
          );
          if (d.place)
            place = { ...d.place, area: d.place.area || "Your live location" };
        } catch {
          /* keep the generic label */
        }
        setPickup(place);
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  }, []);

  // Turn a tapped point into a named place, then assign it.
  const pickOnMap = useCallback(
    async (p: { lat: number; lng: number }) => {
      const target = picking;
      if (!target) return;
      setPicking(null);
      let place: Place = {
        name: "Pinned location",
        area: `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
        lat: p.lat,
        lng: p.lng,
      };
      try {
        const d = await api<{ place: Place }>(
          `/api/rides/reverse?lat=${p.lat}&lng=${p.lng}`,
        );
        if (d.place) place = d.place;
      } catch {
        /* keep the coordinate label */
      }
      if (target === "pickup") setPickup(place);
      else setDrop(place);
    },
    [picking],
  );

  useEffect(() => {
    api<{
      addresses: {
        label: string;
        line1: string;
        city: string;
        lat: number | null;
        lng: number | null;
      }[];
    }>("/api/users/addresses")
      .then((d) =>
        setSaved(
          d.addresses
            .filter((a) => a.lat != null && a.lng != null)
            .map((a) => ({
              name: a.label,
              area: `${a.line1}, ${a.city}`,
              lat: a.lat as number,
              lng: a.lng as number,
            })),
        ),
      )
      .catch(() => setSaved([]));
  }, []);

  // Privacy & Security -> Share My Location gates the automatic read below.
  // Defaults to on when the request fails, matching the server default.
  useEffect(() => {
    api<{ shareLocation: boolean }>("/api/users/preferences")
      .then((p) => setShareLocation(p.shareLocation))
      .catch(() => setShareLocation(true));
  }, []);

  // Auto-fill pickup from the device's live location on first load. Falls back
  // silently to manual entry if permission is denied or GPS is unavailable.
  // Skipped entirely when the rider has turned Share My Location off — they can
  // still tap the locate control, which is an explicit request rather than a
  // silent read.
  useEffect(() => {
    if (shareLocation !== true) return;
    if (!navigator.geolocation) return;
    let cancelled = false;
    // Deferred a tick so the "locating" flag isn't set synchronously during the
    // effect, and so it can never land after a fast GPS fix has already
    // cleared it.
    const start = setTimeout(() => {
      if (cancelled) return;
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          const { latitude: lat, longitude: lng } = pos.coords;
          // Don't override a pickup already chosen (e.g. carried from chat).
          setPickup(
            (prev) =>
              prev ?? {
                name: "Current location",
                area: "Your live location",
                lat,
                lng,
              },
          );
          setLocating(false);
          // Name the GPS point so the rider sees an actual street/area rather
          // than the generic "Current location" label.
          api<{ place: Place }>(`/api/rides/reverse?lat=${lat}&lng=${lng}`)
            .then((d) => {
              if (cancelled || !d.place) return;
              setPickup((prev) =>
                prev && prev.name === "Current location"
                  ? { ...d.place, area: d.place.area || "Your live location" }
                  : prev,
              );
            })
            .catch(() => {
              /* keep the generic label */
            });
        },
        () => !cancelled && setLocating(false),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
      );
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(start);
    };
  }, [shareLocation]);

  // Carried from chat ("book a cab to X"): resolve the destination and set it as
  // the drop — so the screen opens ready, no asking. A saved place ("home" /
  // "work") uses the user's saved address; anything else is geocoded.
  const dropParam = search.get("drop");
  useEffect(() => {
    if (!dropParam) return;
    let cancelled = false;

    async function resolveDrop(query: string) {
      const savedWords = ["home", "work", "office", "house"];
      // 1) Saved place? Match a saved address by label (or the word "home").
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
            addresses.find((a) =>
              query.toLowerCase().includes(a.label.toLowerCase()),
            ) ?? addresses[0];
          if (match) {
            if (match.lat != null && match.lng != null) {
              if (!cancelled)
                setDrop({
                  name: match.label,
                  area: `${match.line1}, ${match.city}`,
                  lat: match.lat,
                  lng: match.lng,
                });
              return;
            }
            // No coords on the saved address → geocode its text.
            query = `${match.line1} ${match.city}`;
          }
        } catch {
          // fall through to plain geocode
        }
      }
      // 2) Geocode the (possibly rewritten) query.
      try {
        const first = (await searchPlaces(query))[0];
        const place = first ? await resolvePlace(first) : null;
        if (!cancelled && place) setDrop(place);
      } catch {
        // leave drop unset; user can search manually
      }
    }

    void resolveDrop(dropParam);
    return () => {
      cancelled = true;
    };
  }, [dropParam]);

  // Reset-during-render when either endpoint is cleared.
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

  useEffect(() => {
    if (!pickup || !drop) return;
    let cancelled = false;
    api<RouteInfo>(
      `/api/rides/route?fromLat=${pickup.lat}&fromLng=${pickup.lng}&toLat=${drop.lat}&toLng=${drop.lng}`,
    )
      .then((r) => !cancelled && setRoute(r))
      .catch(() => !cancelled && setError(t("rd.routeFailed")));
    return () => {
      cancelled = true;
    };
  }, [pickup, drop, t]);

  /**
   * Which fare request is the current one.
   *
   * Changing the vehicle, or moving either endpoint, starts another one before
   * the last has answered, and they do not come back in order. The late answer
   * used to win and take `selected` with it, leaving the rider looking at — and
   * about to book — a fare priced for a trip they had already changed.
   */
  const quoteRun = useRef(0);
  const loadQuotes = useCallback(() => {
    if (!route) return;
    const run = ++quoteRun.current;
    api<{ quotes: RideQuote[]; advice?: Advice }>(
      `/api/rides/quotes?distanceKm=${route.distanceKm.toFixed(2)}&rideMinutes=${route.rideMinutes}&vehicle=${vehicle}`,
    )
      .then((d) => {
        if (run !== quoteRun.current) return;
        setQuotes(d.quotes);
        setAdvice(d.advice ?? null);
        setSelected(d.quotes[0] ?? null);
      })
      .catch(() => run === quoteRun.current && setError(t("rd.optionsFailed")));
  }, [route, vehicle, t]);

  useEffect(loadQuotes, [loadQuotes]);

  const mapPoints = useMemo(
    () => ({
      pickup: pickup ? { lat: pickup.lat, lng: pickup.lng } : null,
      drop: drop ? { lat: drop.lat, lng: drop.lng } : null,
    }),
    [pickup, drop],
  );

  // Shared ride: create the group cart for the selected trip and open the
  // invite screen. Only autos/cabs can be shared (server enforces seats too).
  async function splitWithFriends() {
    if (!selected || !pickup || !drop) return;
    setBusy(true);
    setError("");
    try {
      const cart = await api<{ id: string }>("/api/groups", {
        method: "POST",
        json: {
          domain: "ride",
          ride: {
            provider: selected.provider,
            productName: selected.productName,
            pickup: pickup.name,
            drop: drop.name,
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            dropLat: drop.lat,
            dropLng: drop.lng,
          },
        },
      });
      router.push(`/rides/group/${cart.id}`);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("rd.sharedFailed"),
      );
      setBusy(false);
    }
  }

  async function confirmRide() {
    if (!selected || !pickup || !drop || !route || busy) return;
    setBusy(true);
    setError("");
    try {
      const d = await api<{ order: { id: string } }>("/api/orders", {
        method: "POST",
        // The same attempt key for a double tap or a retried request, so one
        // booking cannot become two orders. The chat's booking card has had
        // this since the duplicate-order bug; this screen, which is where most
        // rides are booked, never got it.
        headers: { "Idempotency-Key": attemptKey.current },
        json: {
          domain: "ride",
          provider: selected.provider,
          productName: selected.productName,
          pickup: pickup.name,
          drop: drop.name,
          // Server recomputes distance & fare from these — it ignores any
          // client-side distance, so the fare can't be tampered with.
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          dropLat: drop.lat,
          dropLng: drop.lng,
          ...(scheduledAt ? { scheduledAt } : {}),
        },
      });
      // Booked. The next trip is a new decision, not a retry of this one.
      attemptKey.current = newAttemptKey();
      router.push(`/pay/${d.order.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("rd.bookFailed"));
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col lg:h-dvh">
      {/* Desktop header — brand mark above the panel+map split (Figma) */}
      <div className="hidden items-center gap-2 px-8 py-4 lg:flex">
        <FlounaLogo size={32} className="text-accent" />
        <span className="text-[22px] font-bold text-accent">Flouna</span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row lg:gap-0 lg:px-8 lg:pb-6">
        {/* Booking panel — mobile: floating bottom sheet; desktop: LEFT panel
            (Figma desktop places the location panel left of the map) */}
        <div className="absolute inset-x-0 bottom-0 z-10 order-2 flex max-h-[58dvh] min-h-0 flex-col gap-3 overflow-y-auto rounded-t-[25px] bg-card px-4 pb-0 pt-5 shadow-[0_-4px_24px_-6px_rgba(0,0,0,0.18)] lg:static lg:order-1 lg:max-h-none lg:w-[420px] lg:flex-none lg:rounded-l-[18px] lg:rounded-tr-none lg:border lg:border-line lg:px-5 lg:shadow-card">
          <FadeIn y={8}>
            <div className="flex items-center justify-between">
              <h1 className="text-[17px] font-bold text-ink">
                {t("rd.selectLocation")}
              </h1>
              <button
                type="button"
                onClick={() => setDrop(null)}
                title={t("rd.chooseDifferent")}
                className="rounded-[17px] bg-beige px-3.5 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:bg-beige/70"
              >
                {t("rd.changeDrop")}
              </button>
            </div>
          </FadeIn>

          {/* Pickup → drop with the Figma connector line */}
          <div className="flex gap-3">
            <div className="flex flex-col items-center pt-3.5">
              <CircleDot size={15} className="shrink-0 text-success" />
              <span className="my-1 w-px flex-1 bg-line" />
              <MapPin size={15} className="shrink-0 text-accent" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <PlaceSearch
                label={locating ? t("rd.locating") : t("rd.pickupLocation")}
                value={pickup}
                onSelect={setPickup}
                near={mapPoints.pickup}
                action={
                  <button
                    type="button"
                    onClick={detectPickup}
                    disabled={locating}
                    aria-label={t("ib.useLocation")}
                    title={t("ib.useLocation")}
                    className="shrink-0 rounded-full p-1.5 text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
                  >
                    {locating ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <LocateFixed size={15} />
                    )}
                  </button>
                }
              />
              <PlaceSearch
                label={t("rd.searchLocation")}
                value={drop}
                onSelect={setDrop}
                near={mapPoints.pickup}
              />
            </div>
          </div>

          {/* Select on map / Add stops — Figma action row */}
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={() =>
                setPicking((p) => (p ? null : pickup ? "drop" : "pickup"))
              }
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-pill border py-2.5 text-[13px] font-semibold transition-colors",
                picking
                  ? "border-accent bg-accent-soft text-accent-ink"
                  : "border-line bg-card text-ink hover:bg-beige/40",
              )}
            >
              <MapPin size={15} className="text-accent" />
              {picking
                ? `Tap the map to set ${picking === "pickup" ? "pickup" : "drop"}`
                : t("rd.selectOnMap")}
            </button>
            <button
              type="button"
              disabled
              className="flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-line bg-card py-2.5 text-[13px] font-semibold text-cocoa/60"
            >
              <Plus size={15} /> {t("rd.addStops")}
            </button>
          </div>

          {/* Suggested locations — saved places, one tap to set as drop (Figma) */}
          {!drop && saved.length > 0 && (
            <div>
              <p className="text-[13px] font-bold text-ink">
                {t("rd.suggested")}
              </p>
              <div className="mt-0.5 flex flex-col divide-y divide-line/70">
                {saved.slice(0, 5).map((p) => (
                  <button
                    key={`${p.lat}-${p.lng}`}
                    onClick={() => setDrop(p)}
                    className="flex items-center gap-2.5 py-2.5 text-left transition-colors hover:bg-beige/30"
                  >
                    <MapPin size={15} className="shrink-0 text-cocoa/60" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium capitalize text-ink">
                        {p.name}
                      </span>
                      <span className="block truncate text-[11px] text-cocoa">
                        {p.area}
                      </span>
                    </span>
                    {pickup && (
                      <span className="shrink-0 text-[12px] text-cocoa">
                        {Math.max(1, Math.round(haversineKm(pickup, p)))} {t("u.km")}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {route && (
            <p className="text-[12px] text-cocoa">
              {t("ib.routeLine")
                .replace("{km}", route.distanceKm.toFixed(1))
                .replace("{min}", String(route.rideMinutes))}
            </p>
          )}

          {pickup && drop && <OndcRideOffers key={`${pickup.lat},${pickup.lng}|${drop.lat},${drop.lng}`} pickup={pickup} drop={drop} />}

          {quotes.length > 0 && (
            <>
              {advice && <AdviceBanner advice={advice} domain="ride" />}
              <div className="flex gap-2">
                {VEHICLES.map((v) => (
                  <button
                    key={v}
                    onClick={() => setVehicle(v)}
                    className={cn(
                      "flex-1 rounded-pill border px-3 py-2 text-[12px] font-semibold capitalize transition-colors",
                      v === vehicle
                        ? "border-accent bg-accent-soft text-accent-ink"
                        : "border-line bg-card text-cocoa hover:bg-beige/40",
                    )}
                  >
                    {t(v === "any" ? "veh.any" : v === "bike" ? "veh.bike" : v === "auto" ? "veh.auto" : "veh.cab")}
                  </button>
                ))}
              </div>

              <Stagger className="flex flex-col gap-2">
                {quotes.map((q) => {
                  const VehicleIcon = VEHICLE_ICON[q.vehicle] ?? Car;
                  const seats = SEATS[q.vehicle];
                  return (
                    <StaggerItem key={`${q.provider}-${q.productName}`}>
                      <button
                        onClick={() => setSelected(q)}
                        className="w-full text-left"
                      >
                        <Card
                          className={cn(
                            "py-3 transition-all hover:-translate-y-0.5 hover:shadow-card",
                            selected === q &&
                              "border-accent/70 ring-1 ring-accent/30",
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-beige/70">
                              <VehicleIcon size={20} className="text-cocoa" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-[14px] font-bold text-ink">
                                {q.displayName}
                              </p>
                              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-cocoa">
                                {seats && (
                                  <span className="flex items-center gap-0.5 whitespace-nowrap">
                                    <Users size={12} />{" "}
                                    {seats > 1 ? t("rd.seats").replace("{n}", String(seats)) : t("rd.seat")}
                                  </span>
                                )}
                                <span className="flex items-center gap-0.5 whitespace-nowrap">
                                  <Clock size={12} /> {q.pickupEtaMinutes} {t("track.minAway")}
                                </span>
                                <span className="flex items-center gap-0.5">
                                  <Star size={12} className="fill-accent text-accent" />
                                  {q.driverRating}
                                </span>
                              </p>
                              {q.offers[0] && (
                                <p className="mt-0.5 text-[11px] text-success">
                                  {q.offers[0].label}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <p className="text-[16px] font-bold text-ink">
                                {rupees(q.effectivePaise)}
                              </p>
                              {q.badge && (
                                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-ink">
                                  {q.badge}
                                </span>
                              )}
                            </div>
                          </div>
                        </Card>
                      </button>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            </>
          )}

          {error && <p className="text-[13px] text-danger">{error}</p>}

          {/* Pinned to the sheet's very bottom and edges, with the sheet's
              padding inside it: a sticky footer stops above its scroller's
              padding, and the fares scrolling by showed in that gap. */}
          <div className="sticky bottom-0 -mx-4 mt-auto bg-card px-4 pb-5 pt-2 lg:-mx-5 lg:px-5">
            {/* Ride now vs schedule for later */}
            {pickup && drop && (
              <div className="mb-2 flex items-center gap-2">
                <button
                  onClick={() => setScheduledAt(null)}
                  className={cn(
                    "rounded-pill px-3 py-1.5 text-[12px] font-semibold transition-colors",
                    !scheduledAt
                      ? "bg-accent-soft text-accent-ink"
                      : "bg-beige/50 text-cocoa hover:text-ink",
                  )}
                >
                  {t("rides.now")}
                </button>
                <input
                  type="datetime-local"
                  aria-label={t("rd.scheduleLater")}
                  value={
                    scheduledAt
                      ? new Date(
                          Date.parse(scheduledAt) -
                            new Date().getTimezoneOffset() * 60_000,
                        )
                          .toISOString()
                          .slice(0, 16)
                      : ""
                  }
                  min={minSchedule}
                  onChange={(e) => {
                    const v = e.target.value;
                    setScheduledAt(v ? new Date(v).toISOString() : null);
                  }}
                  className={cn(
                    "min-w-0 flex-1 rounded-pill border px-3 py-1.5 text-[12px] font-medium outline-none transition-colors",
                    scheduledAt
                      ? "border-accent bg-accent-soft/50 text-accent-ink"
                      : "border-line bg-card text-cocoa",
                  )}
                />
              </div>
            )}
            <Button
              onClick={confirmRide}
              disabled={!selected || busy}
              className="h-[59px] w-full rounded-[25px] text-[15px]"
            >
              {busy
                ? t("rides.booking")
                : selected
                  ? `${scheduledAt ? t("rides.schedule") : t("rides.confirm")} ${selected.displayName} · ${rupees(selected.effectivePaise)}`
                  : pickup && drop
                    ? t("rides.chooseRide")
                    : t("rides.selectDrop")}
            </Button>
            {/* Fare-splitting: autos/cabs only, and a scheduled group is booked now */}
            {selected && !scheduledAt && selected.vehicle !== "bike" && (
              <button
                onClick={splitWithFriends}
                disabled={busy}
                className="mt-2 w-full text-center text-[13px] font-semibold text-accent hover:underline disabled:opacity-50"
              >
                {t("rides.splitFare")}
              </button>
            )}
          </div>
        </div>

        {/* Map — mobile: fills the screen behind the sheet; desktop: right pane */}
        <div className="absolute inset-0 order-1 lg:static lg:order-2 lg:h-full lg:flex-1 lg:overflow-hidden lg:rounded-r-[18px] lg:border lg:border-l-0 lg:border-line">
          <RideMap
            pickup={mapPoints.pickup}
            drop={mapPoints.drop}
            routeGeometry={route?.geometry ?? null}
            onPick={picking ? pickOnMap : null}
          />
        </div>
      </div>
    </div>
  );
}
