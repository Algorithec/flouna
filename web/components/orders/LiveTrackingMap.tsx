"use client";

import { useEffect, useMemo, useState } from "react";
import { BasicMap, type BasicMarker } from "@/components/maps/BasicMap";
import { api } from "@/lib/api";
import { useMapEngine } from "@/lib/maps/googleMaps";
import { GoogleLiveTrackingMap } from "./GoogleLiveTrackingMap";
import { fractionAt, sliceRoute } from "./trackingShared";

export type LatLng = { lat: number; lng: number };

type LiveTrackingMapProps = {
  pickup: LatLng;
  drop: LatLng;
  driverLocation: LatLng | null;
  done: boolean;
  vehicle?: "car" | "bike";
};

/** Live tracking, on Google when a browser key is set and the simplified map otherwise. */
export function LiveTrackingMap(props: LiveTrackingMapProps) {
  const engine = useMapEngine();
  if (engine === "google") return <GoogleLiveTrackingMap {...props} />;
  if (engine === "loading") return <div className="size-full min-h-[260px] bg-beige/40" />;
  return <BasicLiveTrackingMap {...props} />;
}

type RouteInfo = {
  distanceKm: number;
  rideMinutes: number;
  geometry: [number, number][]; // [lng, lat][]
};

// The route, the part already covered, and the vehicle at the server-provided
// live location. `driverLocation` comes from the fulfilment provider
// (simulation or real ONDC) via /api/orders/:id/track; the client never
// invents the position.
function BasicLiveTrackingMap({ pickup, drop, driverLocation, done }: LiveTrackingMapProps) {
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

  const geometry = route?.geometry ?? null;
  const vehicleAt: [number, number] | null =
    geometry && geometry.length > 1 && (driverLocation || done)
      ? done
        ? geometry[geometry.length - 1]!
        : [driverLocation!.lng, driverLocation!.lat]
      : null;

  // Covered portion = route up to the driver's projected position.
  const covered = useMemo(
    () => (geometry && vehicleAt ? sliceRoute(geometry, done ? 1 : fractionAt(geometry, vehicleAt)) : null),
    // vehicleAt is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geometry, driverLocation?.lat, driverLocation?.lng, done],
  );

  const markers = useMemo(() => {
    const out: BasicMarker[] = [
      { at: pickup, color: "#1ca65c" },
      { at: drop, color: "#e8651a" },
    ];
    if (vehicleAt) out.push({ at: { lng: vehicleAt[0], lat: vehicleAt[1] }, color: "#e8651a", vehicle: true });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickup.lat, pickup.lng, drop.lat, drop.lng, vehicleAt?.[0], vehicleAt?.[1]]);

  return <BasicMap markers={markers} route={geometry} covered={covered} className="min-h-[260px]" />;
}
