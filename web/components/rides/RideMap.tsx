"use client";

import { useEffect, useRef } from "react";
import maplibregl, { type Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;
// MapTiler when configured; otherwise the free MapLibre demo style.
const STYLE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : "https://demotiles.maplibre.org/style.json";

export type LatLng = { lat: number; lng: number };

export function RideMap({
  pickup,
  drop,
  routeGeometry,
  pickupLabel,
  dropLabel,
  providers = [],
  onPick,
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
      const el = document.createElement("div");
      el.className =
        "flex items-center gap-1 rounded-full bg-white px-2 py-1 text-[10px] font-bold text-[#3d1c00] shadow-md whitespace-nowrap";
      if (kind === "drop") {
        const flag = document.createElement("span");
        flag.textContent = "🏁";
        flag.className = "text-[10px]";
        el.append(flag, document.createTextNode(text));
      } else {
        const dot = document.createElement("span");
        dot.className = "size-2 shrink-0 rounded-full";
        dot.style.background = "#1ca65c";
        el.append(dot, document.createTextNode(text));
      }
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
    if (providers.length > 0 && routeGeometry && routeGeometry.length > 3) {
      const seen = [...new Set(providers)].slice(0, 3);
      seen.forEach((name, i) => {
        const at = routeGeometry[
          Math.floor(((i + 1) / (seen.length + 1)) * (routeGeometry.length - 1))
        ];
        if (!at) return;
        const el = document.createElement("div");
        const n = name.toLowerCase();
        let bg = "#3d1c00";
        let textCol = "white";
        if (n.includes("ola")) {
          bg = "#bada55";
          textCol = "black";
        } else if (n.includes("uber")) {
          bg = "black";
          textCol = "white";
        } else if (n.includes("rapido")) {
          bg = "#f6d000";
          textCol = "black";
        }
        el.className =
          "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide shadow-md ring-2 ring-white/50";
        el.style.backgroundColor = bg;
        el.style.color = textCol;
        el.textContent = name;
        const m = new maplibregl.Marker({ element: el })
          .setLngLat([at[0], at[1]])
          .addTo(map);
        markersRef.current.push(m);
      });
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
          "line-color": "#e8651a",
          "line-width": 4,
          "line-opacity": 0.85,
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

  return <div ref={containerRef} className="size-full min-h-[260px]" />;
}

/**
 * A place name short enough to sit on a map.
 *
 * "Hitech city Madhapur road, Kothaguda" is a useful line in a form field and
 * a wall of text on a pin, so only the leading part is kept.
 */
function shorten(name: string): string {
  const head = name.split(",")[0]!.trim();
  // Short enough that a label centred on a point near the edge still fits
  // inside the map. The full name is in the field directly below, so this only
  // has to be enough to tell the two ends apart at a glance.
  return head.length > 15 ? `${head.slice(0, 14)}…` : head;
}
