"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MlMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { api } from "@/lib/api";
import { useMapEngine } from "@/lib/maps/googleMaps";
import { GoogleLiveTrackingMap } from "./GoogleLiveTrackingMap";
import { bikeSvg, carSvg, fractionAt, sliceRoute } from "./trackingShared";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;
const STYLE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : "https://demotiles.maplibre.org/style.json";

export type LatLng = { lat: number; lng: number };

type LiveTrackingMapProps = {
  pickup: LatLng;
  drop: LatLng;
  driverLocation: LatLng | null;
  done: boolean;
  vehicle?: "car" | "bike";
};

/** Live tracking, on Google when a browser key is set and MapLibre otherwise. */
export function LiveTrackingMap(props: LiveTrackingMapProps) {
  const engine = useMapEngine();
  if (engine === "google") return <GoogleLiveTrackingMap {...props} />;
  if (engine === "loading") return <div className="size-full min-h-[260px] bg-beige/40" />;
  return <MapLibreLiveTrackingMap {...props} />;
}

type RouteInfo = {
  distanceKm: number;
  rideMinutes: number;
  geometry: [number, number][]; // [lng, lat][]
};

// Renders the route and a driver marker at the server-provided live location.
// `driverLocation` comes from the fulfilment provider (simulation or real ONDC)
// via /api/orders/:id/track — the client never invents the position.
function MapLibreLiveTrackingMap({
  pickup,
  drop,
  driverLocation,
  done,
  vehicle = "car",
}: {
  pickup: LatLng;
  drop: LatLng;
  driverLocation: LatLng | null;
  done: boolean;
  // Marker glyph: rides show a car, food deliveries a scooter.
  vehicle?: "car" | "bike";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const driverRef = useRef<Marker | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);

  // Fetch the route once we know both ends (offline fallback handled by API).
  useEffect(() => {
    let cancelled = false;
    api<RouteInfo>(
      `/api/rides/route?fromLat=${pickup.lat}&fromLng=${pickup.lng}&toLat=${drop.lat}&toLng=${drop.lng}`,
    )
      .then((r) => !cancelled && setRoute(r))
      .catch(() => {
        // Straight line fallback if even the proxy fails.
        if (!cancelled)
          setRoute({
            distanceKm: 0,
            rideMinutes: 0,
            geometry: [
              [pickup.lng, pickup.lat],
              [drop.lng, drop.lat],
            ],
          });
      });
    return () => {
      cancelled = true;
    };
  }, [pickup.lat, pickup.lng, drop.lat, drop.lng]);

  // Init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [pickup.lng, pickup.lat],
      zoom: 12,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      driverRef.current = null;
    };
  }, [pickup.lat, pickup.lng]);

  // Draw route + endpoint markers once the geometry is known.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !route) return;

    const draw = () => {
      if (map.getLayer("route-done")) map.removeLayer("route-done");
      if (map.getLayer("route-line")) map.removeLayer("route-line");
      if (map.getSource("route")) map.removeSource("route");

      map.addSource("route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: route.geometry },
        },
      });
      // Faint full route…
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#e8651a", "line-width": 5, "line-opacity": 0.28 },
      });
      // …with a solid "covered" portion drawn on top (updated as progress grows).
      map.addLayer({
        id: "route-done",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#e8651a", "line-width": 5, "line-opacity": 0.95 },
      });
    };
    if (map.isStyleLoaded()) draw();
    else map.once("load", draw);

    // Pickup (green) + drop (orange) pins
    const pins: Marker[] = [];
    pins.push(
      new maplibregl.Marker({ color: "#1ca65c" })
        .setLngLat([pickup.lng, pickup.lat])
        .addTo(map),
    );
    pins.push(
      new maplibregl.Marker({ color: "#e8651a" })
        .setLngLat([drop.lng, drop.lat])
        .addTo(map),
    );

    map.fitBounds(
      [
        [Math.min(pickup.lng, drop.lng), Math.min(pickup.lat, drop.lat)],
        [Math.max(pickup.lng, drop.lng), Math.max(pickup.lat, drop.lat)],
      ],
      { padding: 70, maxZoom: 14, duration: 0 },
    );

    return () => pins.forEach((p) => p.remove());
  }, [route, pickup.lat, pickup.lng, drop.lat, drop.lng]);

  // Place the driver at the server-provided location; trim the covered route
  // up to the nearest point on the polyline.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !route || route.geometry.length < 2) return;
    if (!driverLocation && !done) return;

    const pos: [number, number] = done
      ? route.geometry[route.geometry.length - 1]!
      : [driverLocation!.lng, driverLocation!.lat];

    if (!driverRef.current) {
      const el = document.createElement("div");
      el.className = "driver-pin";
      el.innerHTML = vehicle === "bike" ? bikeSvg() : carSvg();
      driverRef.current = new maplibregl.Marker({ element: el })
        .setLngLat(pos)
        .addTo(map);
    } else {
      driverRef.current.setLngLat(pos);
    }

    // Covered portion = route up to the driver's projected position.
    const t = done ? 1 : fractionAt(route.geometry, pos);
    const covered = sliceRoute(route.geometry, t);
    const trim = () => {
      if (map.getSource("route-covered")) {
        (map.getSource("route-covered") as maplibregl.GeoJSONSource).setData({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: covered },
        });
      } else if (map.getLayer("route-done")) {
        map.addSource("route-covered", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: covered },
          },
        });
        map.removeLayer("route-done");
        map.addLayer({
          id: "route-done",
          type: "line",
          source: "route-covered",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#e8651a", "line-width": 5, "line-opacity": 0.95 },
        });
      }
    };
    if (map.isStyleLoaded()) trim();
    else map.once("load", trim);
  }, [driverLocation, done, route, vehicle]);

  return <div ref={containerRef} className="size-full min-h-[260px]" />;
}
