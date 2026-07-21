"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, MapPin, Star, Clock, CircleDot, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AdviceBanner, type Advice } from "@/components/ui/AdviceBanner";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";
import type { RideQuote } from "@/components/chat/types";

const RideMap = dynamic(
  () => import("@/components/rides/RideMap").then((m) => m.RideMap),
  { ssr: false, loading: () => <div className="size-full min-h-[260px] animate-pulse bg-beige/50" /> },
);

type Place = { name: string; area: string; lat: number; lng: number };
type RouteInfo = {
  distanceKm: number;
  rideMinutes: number;
  geometry: [number, number][];
};

const VEHICLES = ["any", "bike", "auto", "cab"] as const;

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
}: {
  label: string;
  icon?: React.ReactNode;
  value: Place | null;
  onSelect: (p: Place | null) => void;
}) {
  const [text, setText] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const short = text.length < 2;
    const t = setTimeout(
      () => {
        if (short) {
          setPlaces([]);
          return;
        }
        api<{ places: Place[] }>(`/api/rides/geocode?q=${encodeURIComponent(text)}`)
          .then((d) => {
            setPlaces(d.places);
            setOpen(true);
          })
          .catch(() => setPlaces([]));
      },
      short ? 0 : 250,
    );
    return () => clearTimeout(t);
  }, [text]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-[14px] border border-line bg-card px-3 py-2.5">
        {icon ?? <Search size={15} className="shrink-0 text-cocoa/50" />}
        <input
          value={value ? `${value.name}${value.area ? `, ${value.area}` : ""}` : text}
          onChange={(e) => {
            onSelect(null);
            setText(e.target.value);
          }}
          onFocus={() => places.length > 0 && setOpen(true)}
          placeholder={label}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-cocoa/50"
        />
      </div>
      {open && places.length > 0 && !value && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-[14px] border border-line bg-card shadow-card">
          {places.map((p) => (
            <button
              key={`${p.lat}-${p.lng}`}
              onClick={() => {
                onSelect(p);
                setOpen(false);
                setText("");
              }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] hover:bg-beige/40"
            >
              <MapPin size={14} className="shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">{p.name}</span>
                <span className="block truncate text-[11px] text-cocoa">{p.area}</span>
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
  // Start in "locating" if the browser can geolocate; the async callbacks below
  // resolve it (no synchronous setState inside the effect).
  const [locating, setLocating] = useState(
    () => typeof navigator !== "undefined" && !!navigator.geolocation,
  );
  // "Suggested locations" (Figma) — the user's saved places with coordinates.
  const [saved, setSaved] = useState<Place[]>([]);

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

  // Auto-fill pickup from the device's live location on first load. Falls back
  // silently to manual entry if permission is denied or GPS is unavailable.
  useEffect(() => {
    if (!navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        // Don't override a pickup already chosen (e.g. carried from chat).
        setPickup((prev) =>
          prev ?? {
            name: "Current location",
            area: "Your live location",
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          },
        );
        setLocating(false);
      },
      () => !cancelled && setLocating(false),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
    return () => {
      cancelled = true;
    };
  }, []);

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
        const d = await api<{ places: Place[] }>(
          `/api/rides/geocode?q=${encodeURIComponent(query)}`,
        );
        if (!cancelled && d.places[0]) setDrop(d.places[0]);
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
    api<RouteInfo>(
      `/api/rides/route?fromLat=${pickup.lat}&fromLng=${pickup.lng}&toLat=${drop.lat}&toLng=${drop.lng}`,
    )
      .then(setRoute)
      .catch(() => setError("Could not calculate the route"));
  }, [pickup, drop]);

  const loadQuotes = useCallback(() => {
    if (!route) return;
    api<{ quotes: RideQuote[]; advice?: Advice }>(
      `/api/rides/quotes?distanceKm=${route.distanceKm.toFixed(2)}&rideMinutes=${route.rideMinutes}&vehicle=${vehicle}`,
    )
      .then((d) => {
        setQuotes(d.quotes);
        setAdvice(d.advice ?? null);
        setSelected(d.quotes[0] ?? null);
      })
      .catch(() => setError("Could not fetch ride options"));
  }, [route, vehicle]);

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
      setError(e instanceof Error ? e.message : "Could not start a shared ride");
      setBusy(false);
    }
  }

  async function confirmRide() {
    if (!selected || !pickup || !drop || !route) return;
    setBusy(true);
    setError("");
    try {
      const d = await api<{ order: { id: string } }>("/api/orders", {
        method: "POST",
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
      router.push(`/pay/${d.order.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not book the ride");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col lg:h-dvh">
      {/* Desktop header — brand mark above the panel+map split (Figma) */}
      <div className="hidden items-center gap-2 px-8 py-4 lg:flex">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.png" alt="" className="size-8 rounded-[8px]" />
        <span className="text-[22px] font-bold text-accent">Radiues</span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row lg:gap-0 lg:px-8 lg:pb-6">
        {/* Booking panel — mobile: floating bottom sheet; desktop: LEFT panel
            (Figma desktop places the location panel left of the map) */}
        <div className="absolute inset-x-0 bottom-0 z-10 order-2 flex max-h-[58dvh] min-h-0 flex-col gap-3 overflow-y-auto rounded-t-[25px] bg-white px-4 py-5 shadow-[0_-4px_24px_-6px_rgba(0,0,0,0.18)] lg:static lg:order-1 lg:max-h-none lg:w-[420px] lg:flex-none lg:rounded-l-[18px] lg:rounded-tr-none lg:border lg:border-line lg:px-5 lg:shadow-card">
        <FadeIn y={8}>
          <div className="flex items-center justify-between">
            <h1 className="text-[17px] font-bold text-[#1a1a2e]">Select your location</h1>
            <button
              type="button"
              onClick={() => {
                setPickup(null);
                setDrop(null);
              }}
              className="rounded-[17px] bg-[#f0e8e0] px-3.5 py-1.5 text-[13px] font-semibold text-[#2d2d2d] transition-colors hover:bg-[#e6dccf]"
            >
              Change
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
              label={locating ? "Locating you…" : "Pickup location"}
              value={pickup}
              onSelect={setPickup}
            />
            <PlaceSearch
              label="Search for a location…"
              value={drop}
              onSelect={setDrop}
            />
          </div>
        </div>

        {/* Select on map / Add stops — Figma action row */}
        <div className="flex gap-2.5">
          <button
            type="button"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-line bg-card py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-beige/40"
          >
            <MapPin size={15} className="text-accent" /> Select on map
          </button>
          <button
            type="button"
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-line bg-card py-2.5 text-[13px] font-semibold text-cocoa/60"
          >
            <Plus size={15} /> Add stops
          </button>
        </div>

        {/* Suggested locations — saved places, one tap to set as drop (Figma) */}
        {!drop && saved.length > 0 && (
          <div>
            <p className="text-[13px] font-bold text-ink">Suggested locations</p>
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
                    <span className="block truncate text-[11px] text-cocoa">{p.area}</span>
                  </span>
                  {pickup && (
                    <span className="shrink-0 text-[12px] text-cocoa">
                      {Math.max(1, Math.round(haversineKm(pickup, p)))} km
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {route && (
          <p className="text-[12px] text-cocoa">
            {route.distanceKm.toFixed(1)} km · about {route.rideMinutes} min
          </p>
        )}

        {quotes.length > 0 && (
          <>
            {advice && <AdviceBanner advice={advice} />}
            <div className="flex gap-2">
              {VEHICLES.map((v) => (
                <button
                  key={v}
                  onClick={() => setVehicle(v)}
                  className={cn(
                    "flex-1 rounded-pill border px-3 py-2 text-[12px] font-semibold capitalize transition-colors",
                    v === vehicle
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line bg-card text-cocoa hover:bg-beige/40",
                  )}
                >
                  {v === "any" ? "All" : v}
                </button>
              ))}
            </div>

            <Stagger className="flex flex-col gap-2">
              {quotes.map((q) => (
                <StaggerItem key={`${q.provider}-${q.productName}`}>
                <button
                  onClick={() => setSelected(q)}
                  className="w-full text-left"
                >
                  <Card
                    className={cn(
                      "py-3 transition-all hover:-translate-y-0.5 hover:shadow-card",
                      selected === q && "border-accent/70 ring-1 ring-accent/30",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-[14px] font-bold text-ink">
                          {q.displayName}
                          {q.badge && (
                            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
                              {q.badge}
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 flex items-center gap-2 text-[12px] text-cocoa">
                          <span className="flex items-center gap-0.5">
                            <Clock size={12} /> {q.pickupEtaMinutes} min
                          </span>
                          <span className="flex items-center gap-0.5">
                            <Star size={12} className="fill-accent text-accent" />
                            {q.driverRating}
                          </span>
                        </p>
                        {q.offers[0] && (
                          <p className="text-[11px] text-success">{q.offers[0].label}</p>
                        )}
                      </div>
                      <p className="shrink-0 text-[16px] font-bold text-ink">
                        {rupees(q.effectivePaise)}
                      </p>
                    </div>
                  </Card>
                </button>
                </StaggerItem>
              ))}
            </Stagger>
          </>
        )}

        {error && <p className="text-[13px] text-danger">{error}</p>}

        <div className="sticky bottom-0 mt-auto bg-white pb-1 pt-2">
          {/* Ride now vs schedule for later */}
          {pickup && drop && (
            <div className="mb-2 flex items-center gap-2">
              <button
                onClick={() => setScheduledAt(null)}
                className={cn(
                  "rounded-pill px-3 py-1.5 text-[12px] font-semibold transition-colors",
                  !scheduledAt
                    ? "bg-accent-soft text-accent"
                    : "bg-beige/50 text-cocoa hover:text-ink",
                )}
              >
                {t("rides.now")}
              </button>
              <input
                type="datetime-local"
                aria-label="Schedule for later"
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
                  "flex-1 rounded-pill border px-3 py-1.5 text-[12px] font-medium outline-none transition-colors",
                  scheduledAt
                    ? "border-accent bg-accent-soft/50 text-accent"
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
          />
        </div>
      </div>
    </div>
  );
}
