"use client";

import { useEffect, useState } from "react";

// Google Maps, loaded once, with a simplified map as the fallback.
//
// Every map in the app runs on Google when NEXT_PUBLIC_GOOGLE_MAPS_KEY is set,
// and on the simplified map (components/maps/BasicMap) otherwise. Google's terms forbid drawing its routes or
// places on another provider's map, so once the server uses Google the web
// has to as well.
//
// The fallback also covers Google failing after the key is set: a blocked
// script, a timeout, or the key being refused (wrong site, API off, billing).
// A map that shows Google's grey error box is worse than the simplified map,
// so on any of those the app quietly uses that one instead.

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
// Custom HTML markers need a map id. Google's demo id works for development;
// production should set its own from Google Maps Platform → Map management.
export const GOOGLE_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || "DEMO_MAP_ID";

// ---- the slice of the Maps JavaScript API this app uses ----
//
// Typed here rather than by adding @types/google.maps: installing it on
// Windows pruned platform-specific optional packages from the lockfile, which
// would have changed what CI and Railway install for no gain.

export type LatLngLiteral = { lat: number; lng: number };
export interface GListener {
  remove(): void;
}
export interface GMap {
  fitBounds(
    bounds: GLatLngBounds,
    padding?: number | { top: number; bottom: number; left: number; right: number },
  ): void;
  panTo(p: LatLngLiteral): void;
  setZoom(z: number): void;
  getZoom(): number | undefined;
  getCenter(): { lat(): number; lng(): number } | undefined;
  setOptions(o: Record<string, unknown>): void;
  addListener(event: string, fn: (e: { latLng?: { lat(): number; lng(): number } }) => void): GListener;
}
export interface GLatLngBounds {
  extend(p: LatLngLiteral): GLatLngBounds;
}
export interface GPolyline {
  setMap(m: GMap | null): void;
  setPath(p: LatLngLiteral[]): void;
}
export interface GAdvancedMarker {
  map: GMap | null;
  position: LatLngLiteral | null;
}
export interface GMaps {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
  LatLngBounds: new () => GLatLngBounds;
  Polyline: new (opts: Record<string, unknown>) => GPolyline;
  ControlPosition: Record<string, number>;
  event: { addListenerOnce(target: unknown, event: string, fn: () => void): GListener };
  marker: {
    AdvancedMarkerElement: new (opts: {
      map?: GMap;
      position: LatLngLiteral;
      content?: HTMLElement;
      zIndex?: number;
    }) => GAdvancedMarker;
    PinElement: new (opts: {
      background?: string;
      borderColor?: string;
      glyphColor?: string;
      scale?: number;
      // The pin is itself the element to show. Its old .element property is
      // deprecated and logs a warning on every marker.
    }) => HTMLElement;
  };
}

// ---- loading ----

type WindowWithMaps = Window & {
  google?: { maps?: GMaps };
  gm_authFailure?: () => void;
  [callback: string]: unknown;
};

let loading: Promise<GMaps> | null = null;
let refused = false;
const refusalListeners = new Set<() => void>();

/** Loads the Maps script once per page. Rejects on any failure. */
export function loadGoogleMaps(): Promise<GMaps> {
  if (!KEY) return Promise.reject(new Error("No Google Maps key"));
  if (refused) return Promise.reject(new Error("Google refused the key"));
  if (loading) return loading;

  loading = new Promise<GMaps>((resolve, reject) => {
    const w = window as unknown as WindowWithMaps;
    if (w.google?.maps?.Map) {
      resolve(w.google.maps);
      return;
    }
    const callback = "__flounaGoogleMapsReady";
    w[callback] = () => (w.google?.maps ? resolve(w.google.maps) : reject(new Error("No maps")));
    // Google calls this, globally, when it refuses the key. It can arrive after
    // the script has loaded and a map is already on screen.
    w.gm_authFailure = () => {
      refused = true;
      refusalListeners.forEach((fn) => fn());
    };

    const params = new URLSearchParams({
      key: KEY,
      v: "weekly",
      libraries: "marker",
      loading: "async",
      callback,
      region: "IN",
      language: "en",
    });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      // Nothing loaded, so a later map may try again with a fresh script.
      script.remove();
      reject(Object.assign(new Error("Google Maps did not load"), { retryable: true }));
    };
    document.head.appendChild(script);
    // A venue network that silently drops the request never fires onerror.
    // Not retryable: the script may still arrive, and a second copy added
    // while the first is loading is an error of its own in Google's loader.
    setTimeout(() => reject(new Error("Google Maps timed out")), 8000);
  });
  loading.catch((err: { retryable?: boolean }) => {
    if (err?.retryable) loading = null;
  });
  return loading;
}

export type MapEngine = "google" | "basic" | "loading";

/**
 * Which map to draw. "loading" only ever appears when a key is set, so a
 * simplified map is never drawn and then swapped out underneath the user.
 */
export function useMapEngine(): MapEngine {
  const [engine, setEngine] = useState<MapEngine>(KEY && !refused ? "loading" : "basic");
  useEffect(() => {
    if (!KEY || refused) return;
    let alive = true;
    const onRefused = () => alive && setEngine("basic");
    refusalListeners.add(onRefused);
    loadGoogleMaps()
      .then(() => alive && !refused && setEngine("google"))
      .catch(() => alive && setEngine("basic"));
    return () => {
      alive = false;
      refusalListeners.delete(onRefused);
    };
  }, []);
  return engine;
}

/** [lng, lat] pairs, as the server sends routes, to Google's literals. */
export function toLatLngs(geometry: [number, number][]): LatLngLiteral[] {
  return geometry.map(([lng, lat]) => ({ lat, lng }));
}

/** Base options shared by every map: our controls, no clutter. */
export function baseMapOptions(maps: GMaps, center: LatLngLiteral, zoom: number) {
  return {
    center,
    zoom,
    mapId: GOOGLE_MAP_ID,
    disableDefaultUI: true,
    zoomControl: true,
    zoomControlOptions: { position: maps.ControlPosition.RIGHT_TOP },
    clickableIcons: false,
    // One finger scrolls the page; two move the map. These maps sit inside
    // scrolling screens, and a map that captured every swipe trapped people.
    gestureHandling: "cooperative",
  };
}

/** Fits two points, then stops short of street level. */
export function fitTwo(
  maps: GMaps,
  map: GMap,
  a: LatLngLiteral,
  b: LatLngLiteral,
  padding: number | { top: number; bottom: number; left: number; right: number },
  maxZoom = 14,
) {
  const bounds = new maps.LatLngBounds().extend(a).extend(b);
  map.fitBounds(bounds, padding);
  maps.event.addListenerOnce(map, "idle", () => {
    const z = map.getZoom();
    if (z !== undefined && z > maxZoom) map.setZoom(maxZoom);
  });
}
