"use client";

import { useEffect, useRef } from "react";
import {
  baseMapOptions,
  fitTwo,
  loadGoogleMaps,
  toLatLngs,
  type GAdvancedMarker,
  type GMap,
  type GMaps,
  type GPolyline,
} from "@/lib/maps/googleMaps";
import {
  placeLabelElement,
  providerPillElement,
  providerPositions,
  shorten,
} from "./rideMapShared";
import type { LatLng } from "./RideMap";

// The ride map on Google: the same pins, names, providers and route as the
// MapLibre version, drawn by Google so a Google route sits on a Google map.

/** Shifts a marker's content so it sits below its point instead of above. */
function below(el: HTMLElement, gap = 4): HTMLElement {
  el.style.transform = `translateY(calc(100% + ${gap}px))`;
  return el;
}

/** Centres a marker's content on its point. */
function centred(el: HTMLElement): HTMLElement {
  el.style.transform = "translateY(50%)";
  return el;
}

export function GoogleRideMap({
  pickup,
  drop,
  routeGeometry,
  pickupLabel,
  dropLabel,
  providers = [],
  onPick,
  className,
}: {
  pickup: LatLng | null;
  drop: LatLng | null;
  routeGeometry: [number, number][] | null;
  pickupLabel?: string | null;
  dropLabel?: string | null;
  providers?: string[];
  onPick?: ((p: LatLng) => void) | null;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapsRef = useRef<GMaps | null>(null);
  const mapRef = useRef<GMap | null>(null);
  const markersRef = useRef<GAdvancedMarker[]>([]);
  const lineRef = useRef<GPolyline | null>(null);
  const onPickRef = useRef(onPick);
  // Bumped once the map exists, so the drawing effect runs after it.
  const readyRef = useRef(false);
  const redrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        const map = new maps.Map(
          containerRef.current,
          baseMapOptions(maps, { lat: 17.385, lng: 78.4747 }, 11),
        );
        map.addListener("click", (e) => {
          if (e.latLng) onPickRef.current?.({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        });
        mapsRef.current = maps;
        mapRef.current = map;
        readyRef.current = true;
        redrawRef.current();
      })
      .catch(() => {
        // The wrapper sees the same failure and swaps to MapLibre.
      });
    return () => {
      cancelled = true;
      markersRef.current.forEach((m) => (m.map = null));
      lineRef.current?.setMap(null);
      mapRef.current = null;
    };
  }, []);

  // Keep the click handler current, and show a crosshair while picking.
  useEffect(() => {
    onPickRef.current = onPick;
    mapRef.current?.setOptions({ draggableCursor: onPick ? "crosshair" : null });
  }, [onPick]);

  useEffect(() => {
    const draw = () => {
      const maps = mapsRef.current;
      const map = mapRef.current;
      if (!maps || !map) return;

      markersRef.current.forEach((m) => (m.map = null));
      markersRef.current = [];
      lineRef.current?.setMap(null);
      lineRef.current = null;

      const pin = (point: LatLng, color: string) => {
        const glyph = new maps.marker.PinElement({
          background: color,
          borderColor: color,
          glyphColor: "#ffffff",
        });
        markersRef.current.push(
          new maps.marker.AdvancedMarkerElement({ map, position: point, content: glyph.element }),
        );
      };
      const label = (point: LatLng, text: string, kind: "pickup" | "drop") => {
        markersRef.current.push(
          new maps.marker.AdvancedMarkerElement({
            map,
            position: point,
            content: below(placeLabelElement(shorten(text), kind)),
            zIndex: 2,
          }),
        );
      };

      if (pickup) {
        pin(pickup, "#1ca65c");
        if (pickupLabel) label(pickup, pickupLabel, "pickup");
      }
      if (drop) {
        pin(drop, "#e8651a");
        if (dropLabel) label(drop, dropLabel, "drop");
      }

      for (const { name, at } of providerPositions(providers, routeGeometry)) {
        markersRef.current.push(
          new maps.marker.AdvancedMarkerElement({
            map,
            position: { lat: at[1], lng: at[0] },
            content: centred(providerPillElement(name)),
          }),
        );
      }

      if (routeGeometry && routeGeometry.length >= 2) {
        lineRef.current = new maps.Polyline({
          map,
          path: toLatLngs(routeGeometry),
          strokeColor: "#3b82f6",
          strokeWeight: 3.5,
          strokeOpacity: 0.95,
        });
      }

      if (pickup && drop) {
        // Room for the names, which sit below their points: half a label's
        // width at the sides and a whole one at the bottom.
        fitTwo(maps, map, pickup, drop, { top: 26, bottom: 44, left: 52, right: 52 });
      } else if (pickup || drop) {
        map.panTo((pickup ?? drop)!);
        map.setZoom(13);
      }
    };
    redrawRef.current = draw;
    if (readyRef.current) draw();
  }, [pickup, drop, routeGeometry, pickupLabel, dropLabel, providers]);

  return (
    <div ref={containerRef} className={`size-full min-h-[260px] ${className ?? ""}`} />
  );
}
