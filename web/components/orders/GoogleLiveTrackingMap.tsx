"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
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
import { bikeSvg, carSvg, fractionAt, sliceRoute } from "./trackingShared";
import type { LatLng } from "./LiveTrackingMap";

// Live tracking on Google: the whole route faint, the part already covered
// solid, and the vehicle at the head of it. Same maths as the simplified map.

type RouteInfo = {
  distanceKm: number;
  rideMinutes: number;
  geometry: [number, number][]; // [lng, lat][]
};

export function GoogleLiveTrackingMap({
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
  vehicle?: "car" | "bike";
}) {
  const { lat: pickupLat, lng: pickupLng } = pickup;
  const { lat: dropLat, lng: dropLng } = drop;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapsRef = useRef<GMaps | null>(null);
  const mapRef = useRef<GMap | null>(null);
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const fullRef = useRef<GPolyline | null>(null);
  const coveredRef = useRef<GPolyline | null>(null);
  const driverRef = useRef<GAdvancedMarker | null>(null);

  // The road route between the two ends; a straight line if it cannot be had.
  useEffect(() => {
    let cancelled = false;
    api<RouteInfo>(
      `/api/rides/route?fromLat=${pickup.lat}&fromLng=${pickup.lng}&toLat=${drop.lat}&toLng=${drop.lng}`,
    )
      .then((r) => !cancelled && setRoute(r))
      .catch(() => {
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

  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps()
      .then((maps) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        mapsRef.current = maps;
        mapRef.current = new maps.Map(containerRef.current, baseMapOptions(maps, pickup, 12));
        setReady(true);
      })
      .catch(() => {
        // The wrapper sees the same failure and swaps to the simplified map.
      });
    return () => {
      cancelled = true;
      fullRef.current?.setMap(null);
      coveredRef.current?.setMap(null);
      if (driverRef.current) driverRef.current.map = null;
      mapRef.current = null;
    };
    // The map is made once; the ends are drawn by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route and the two ends.
  useEffect(() => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!ready || !maps || !map || !route) return;
    // Rebuilt from the values, not the objects: a parent that passes fresh
    // objects on every poll would otherwise re-fit the map and yank the view.
    const from = { lat: pickupLat, lng: pickupLng };
    const to = { lat: dropLat, lng: dropLng };

    const path = toLatLngs(route.geometry);
    fullRef.current?.setMap(null);
    coveredRef.current?.setMap(null);
    fullRef.current = new maps.Polyline({
      map,
      path,
      strokeColor: "#e8651a",
      strokeWeight: 5,
      strokeOpacity: 0.28,
    });
    coveredRef.current = new maps.Polyline({
      map,
      path: [],
      strokeColor: "#e8651a",
      strokeWeight: 5,
      strokeOpacity: 0.95,
      zIndex: 2,
    });

    const pins = [
      { at: from, color: "#1ca65c" },
      { at: to, color: "#e8651a" },
    ].map(({ at, color }) => {
      const glyph = new maps.marker.PinElement({
        background: color,
        borderColor: color,
        glyphColor: "#ffffff",
      });
      return new maps.marker.AdvancedMarkerElement({ map, position: at, content: glyph });
    });

    fitTwo(maps, map, from, to, 70);
    return () => pins.forEach((p) => (p.map = null));
  }, [ready, route, pickupLat, pickupLng, dropLat, dropLng]);

  // The vehicle, and how much of the route is behind it.
  useEffect(() => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!ready || !maps || !map || !route || route.geometry.length < 2) return;
    if (!driverLocation && !done) return;

    const pos: [number, number] = done
      ? route.geometry[route.geometry.length - 1]!
      : [driverLocation!.lng, driverLocation!.lat];
    const position = { lat: pos[1], lng: pos[0] };

    if (!driverRef.current) {
      const el = document.createElement("div");
      el.className = "driver-pin";
      el.innerHTML = vehicle === "bike" ? bikeSvg() : carSvg();
      // Centred on the point.
      el.style.transform = "translateY(50%)";
      driverRef.current = new maps.marker.AdvancedMarkerElement({
        map,
        position,
        content: el,
        zIndex: 3,
      });
    } else {
      driverRef.current.position = position;
    }

    const t = done ? 1 : fractionAt(route.geometry, pos);
    coveredRef.current?.setPath(toLatLngs(sliceRoute(route.geometry, t)));
  }, [ready, driverLocation, done, route, vehicle]);

  return <div ref={containerRef} className="size-full min-h-[260px]" />;
}
