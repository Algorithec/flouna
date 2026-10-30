"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocateFixed, Loader2, MapPin } from "lucide-react";
import { BasicMap } from "@/components/maps/BasicMap";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { baseMapOptions, loadGoogleMaps, useMapEngine } from "@/lib/maps/googleMaps";

const HYDERABAD = { lat: 17.385, lng: 78.4867 };

export type ResolvedAddress = {
  line1: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  formatted: string;
};

export type PickedLocation = {
  lat: number;
  lng: number;
  address: ResolvedAddress;
};

// Map-first location picker. The pin is fixed to the centre of the frame and
// the map moves underneath it — the pattern every delivery app uses, because
// it works with one thumb and never asks you to hit a small target. Each
// settle reverse-geocodes so the caller can auto-fill an address form.
export function LocationPicker({
  initial,
  onChange,
  height = 220,
  className,
}: {
  initial?: { lat: number; lng: number } | null;
  onChange: (picked: PickedLocation) => void;
  height?: number;
  className?: string;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  // Moves the map under the fixed pin, whichever engine is drawing it.
  const moveToRef = useRef<((lat: number, lng: number) => void) | null>(null);
  const engine = useMapEngine();
  const onChangeRef = useRef(onChange);
  const [resolving, setResolving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [label, setLabel] = useState(t("lp.move"));
  const [error, setError] = useState("");
  // What the simplified map shows; only used when Google is not available.
  const [basicView, setBasicView] = useState(() => ({
    center: initial ?? HYDERABAD,
    spanKm: initial ? 1.5 : 8,
  }));

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  /**
   * Which pin we are naming.
   *
   * Every settle of the map starts a lookup, and on a slow connection a person
   * dragging the pin twice has two running. The older answer could come back
   * last and hand the caller the address of a place the pin had already left —
   * which is the address that gets written into the delivery form, against the
   * newer coordinates. Only the newest lookup is allowed to answer.
   */
  const resolveRun = useRef(0);

  // Reverse-geocode the current centre and hand the parts back up.
  const resolve = useCallback(async (lat: number, lng: number) => {
    const run = ++resolveRun.current;
    setResolving(true);
    setError("");
    try {
      const d = await api<{ address: ResolvedAddress }>(
        `/api/rides/reverse?lat=${lat}&lng=${lng}`,
      );
      if (run !== resolveRun.current) return;
      const address = d.address;
      setLabel(address.formatted || t("lp.pinned"));
      onChangeRef.current({ lat, lng, address });
    } catch {
      if (run !== resolveRun.current) return;
      // Keep the coordinates usable even if naming failed — the user can type
      // the address themselves rather than being blocked.
      setLabel(t("lp.couldntName"));
      onChangeRef.current({
        lat,
        lng,
        address: { line1: "", area: "", city: "", state: "", pincode: "", formatted: "" },
      });
    } finally {
      if (run === resolveRun.current) setResolving(false);
    }
  }, [t]);

  useEffect(() => {
    // Google loads first when a key is set; nothing is drawn until it decides.
    if (engine === "loading") return;
    const start = initial ?? HYDERABAD;
    const zoom = initial ? 16 : 12;
    let cancelled = false;
    let teardown: () => void = () => {};

    // The simplified map: a tap moves the pin to the tapped point.
    if (engine === "basic") {
      moveToRef.current = (lat, lng) => {
        setBasicView({ center: { lat, lng }, spanKm: 1.5 });
        void resolve(lat, lng);
      };
      // Named after the effect, so no state is set while it runs.
      if (initial) {
        void Promise.resolve().then(() => {
          if (!cancelled) void resolve(initial.lat, initial.lng);
        });
      }
      return () => {
        cancelled = true;
        moveToRef.current = null;
      };
    }
    if (!containerRef.current) return;

    if (engine === "google") {
      void loadGoogleMaps()
        .then((maps) => {
          if (cancelled || !containerRef.current) return;
          const map = new maps.Map(containerRef.current, baseMapOptions(maps, start, zoom));
          // "idle" is Google's moveend, except that it also fires once the
          // map first settles. That first one only names the pin when a start
          // was given.
          let first = true;
          const listener = map.addListener("idle", () => {
            const skip = first && !initial;
            first = false;
            if (skip) return;
            const c = map.getCenter();
            if (c) void resolve(c.lat(), c.lng());
          });
          moveToRef.current = (lat, lng) => {
            map.panTo({ lat, lng });
            map.setZoom(17);
          };
          teardown = () => listener.remove();
        })
        .catch(() => {
          // The engine hook sees the same failure and swaps to the simplified map.
        });
      return () => {
        cancelled = true;
        teardown();
        moveToRef.current = null;
      };
    }
    // Built once per engine — `initial` is a starting position, not a live binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  function useMyLocation() {
    if (!navigator.geolocation) {
      setError(t("lp.unavailable"));
      return;
    }
    setLocating(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude: lat, longitude: lng } = pos.coords;
        // flyTo triggers moveend, which resolves the address.
        moveToRef.current?.(lat, lng);
      },
      () => {
        setLocating(false);
        setError(t("lp.denied"));
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }

  return (
    <div className={className}>
      <div
        className="relative overflow-hidden rounded-card border border-line"
        style={{ height }}
      >
        {engine === "basic" ? (
          <BasicMap
            markers={[]}
            center={basicView.center}
            spanKm={basicView.spanKm}
            onPick={(p) => moveToRef.current?.(p.lat, p.lng)}
          />
        ) : (
          <div ref={containerRef} className="size-full" />
        )}

        {/* Fixed centre pin — the map moves under it. Slightly above centre so
            the point sits at the tip, not the middle of the icon. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full"
        >
          <MapPin
            size={34}
            className="fill-accent text-accent drop-shadow-[0_2px_4px_rgba(0,0,0,0.3)]"
          />
        </div>

        {/* Use my location — the primary way in. Top-left: the bottom edge is
            taken by the map attribution, which this used to overlap. */}
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating}
          className="absolute left-3 top-3 flex items-center gap-1.5 rounded-pill bg-card px-3.5 py-2 text-[12px] font-semibold text-accent shadow-card transition-colors hover:bg-beige/60 disabled:opacity-60"
        >
          {locating ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <LocateFixed size={14} />
          )}
          {locating ? t("lp.locating") : t("ib.useLocation")}
        </button>
      </div>

      {/* Resolved address readout */}
      <div className="mt-2 flex items-start gap-2 px-0.5">
        <MapPin size={14} className="mt-0.5 shrink-0 text-accent" />
        <p
          className={cn(
            "min-w-0 flex-1 text-[12px] leading-relaxed",
            resolving ? "text-cocoa/60" : "text-cocoa",
          )}
        >
          {resolving ? t("lp.finding") : label}
        </p>
      </div>
      {error && <p className="mt-1 px-0.5 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
