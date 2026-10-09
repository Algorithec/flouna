"use client";

import { useEffect, useRef } from "react";
import maplibregl, { type Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useMapEngine } from "@/lib/maps/googleMaps";
import { GoogleRideMap } from "./GoogleRideMap";
import {
  placeLabelElement,
  providerPillElement,
  providerPositions,
  shorten,
} from "./rideMapShared";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;
// MapTiler when configured; otherwise the free MapLibre demo style.
const STYLE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : "https://demotiles.maplibre.org/style.json";

export type LatLng = { lat: number; lng: number };

type RideMapProps = {
  pickup: LatLng | null;
  drop: LatLng | null;
  routeGeometry: [number, number][] | null;
  /** Names for the two ends, so the map says where it is rather than showing
      two anonymous pins. */
  pickupLabel?: string | null;
  dropLabel?: string | null;
  /** Providers covering this route, shown along it. */
  providers?: string[];
  // Set while the user is choosing a point by tapping the map. Kept in a ref
  // so toggling it doesn't tear the map down and rebuild it.
  onPick?: ((p: LatLng) => void) | null;
  className?: string;
};

/**
 * The ride map, on Google when a browser key is set and MapLibre otherwise.
 * While Google loads, an empty frame holds the space, so a MapLibre map is
 * never drawn and then swapped out from under the rider.
 */
export function RideMap(props: RideMapProps) {
  const engine = useMapEngine();
  if (engine === "google") return <GoogleRideMap {...props} />;
  if (engine === "loading")
    return <div className={`size-full min-h-[260px] bg-beige/40 ${props.className ?? ""}`} />;
  return <MapLibreRideMap {...props} />;
}

function MapLibreRideMap({
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
  /** Names for the two ends, so the map says where it is rather than showing
      two anonymous pins. */
  pickupLabel?: string | null;
  dropLabel?: string | null;
  /** Providers covering this route, shown along it. */
  providers?: string[];
  // Set while the user is choosing a point by tapping the map. Kept in a ref
  // so toggling it doesn't tear the map down and rebuild it.
  onPick?: ((p: LatLng) => void) | null;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const onPickRef = useRef(onPick);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [78.4747, 17.385], // Hyderabad
      zoom: 11,
      // Added explicitly below rather than left at its default. The default
      // sits bottom-right, which on this screen is underneath the location
      // sheet — MapTiler and OpenStreetMap both require the credit to stay
      // legible, so it goes top-left where nothing covers it.
      attributionControl: false,
    });
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "top-left",
    );
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("click", (e) => {
      onPickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Keep the click handler current, and show a crosshair while picking so the
  // map reads as interactive.
  useEffect(() => {
    onPickRef.current = onPick;
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = onPick ? "crosshair" : "";
  }, [onPick]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const addMarker = (point: LatLng, color: string) => {
      const marker = new maplibregl.Marker({ color })
        .setLngLat([point.lng, point.lat])
        .addTo(map);
      markersRef.current.push(marker);
    };

    /**
     * A named place, as a pill sitting on the point.
     *
     * Two identical pins tell a rider nothing about which end is which. The
     * name is the thing they are checking before they book, so it belongs on
     * the map rather than only in the field below it.
     */
    const addLabel = (point: LatLng, text: string, kind: "pickup" | "drop") => {
      const el = placeLabelElement(text, kind);
      // Under the point, not over it. A pin points down, so the space above it
      // is where the pin body and the map's own zoom and attribution controls
      // are, and a destination in the top corner had its name clipped off the
      // edge every time. Below the point is reliably free.
      const m = new maplibregl.Marker({ element: el, anchor: "top", offset: [0, 4] })
        .setLngLat([point.lng, point.lat])
        .addTo(map);
      markersRef.current.push(m);
    };

    if (pickup) {
      addMarker(pickup, "#1ca65c");
      if (pickupLabel) addLabel(pickup, shorten(pickupLabel), "pickup");
    }
    if (drop) {
      addMarker(drop, "#e8651a");
      if (dropLabel) addLabel(drop, shorten(dropLabel), "drop");
    }

    // The providers that cover this route, spaced along it. Evidence that the
    // comparison happened, placed where the route is rather than as another
    // line of text under it.
    for (const { name, at } of providerPositions(providers, routeGeometry)) {
      const m = new maplibregl.Marker({ element: providerPillElement(name) })
        .setLngLat([at[0], at[1]])
        .addTo(map);
      markersRef.current.push(m);
    }

    const drawRoute = () => {
      if (map.getLayer("route-line")) map.removeLayer("route-line");
      if (map.getSource("route")) map.removeSource("route");
      if (!routeGeometry || routeGeometry.length < 2) return;
      map.addSource("route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: routeGeometry },
        },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
          "line-color": "#3b82f6",
          "line-width": 3.5,
          "line-opacity": 0.95,
        },
      });
    };
    if (map.isStyleLoaded()) drawRoute();
    else map.once("load", drawRoute);

    if (pickup && drop) {
      map.fitBounds(
        [
          [Math.min(pickup.lng, drop.lng), Math.min(pickup.lat, drop.lat)],
          [Math.max(pickup.lng, drop.lng), Math.max(pickup.lat, drop.lat)],
        ],
        // Extra room at the top, because the place labels sit above their
        // pins and an even padding clipped the destination's name off the
        // edge of a 190px-tall map.
        // Room for the labels, which sit below their points and are centred
        // on them: the sides need half a label's width or a name in a corner
        // gets cut in half, and the bottom needs a whole one.
        { padding: { top: 26, bottom: 44, left: 52, right: 52 }, maxZoom: 14 },
      );
    } else if (pickup || drop) {
      const p = (pickup ?? drop)!;
      map.flyTo({ center: [p.lng, p.lat], zoom: 13 });
    }
  }, [pickup, drop, routeGeometry, pickupLabel, dropLabel, providers]);

  return (
    <div ref={containerRef} className={`size-full min-h-[260px] ${className ?? ""}`} />
  );
}
