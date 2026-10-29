"use client";

import { useMemo } from "react";
import { BasicMap, type BasicMarker } from "@/components/maps/BasicMap";
import { useMapEngine } from "@/lib/maps/googleMaps";
import { GoogleRideMap } from "./GoogleRideMap";
import { shorten } from "./rideMapShared";

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
  // Set while the user is choosing a point by tapping the map.
  onPick?: ((p: LatLng) => void) | null;
  className?: string;
};

/**
 * The ride map, on Google when a browser key is set and the simplified map
 * otherwise. While Google loads, an empty frame holds the space, so the
 * simplified map is never drawn and then swapped out from under the rider.
 */
export function RideMap(props: RideMapProps) {
  const engine = useMapEngine();
  if (engine === "google") return <GoogleRideMap {...props} />;
  if (engine === "loading")
    return <div className={`size-full min-h-[260px] bg-beige/40 ${props.className ?? ""}`} />;
  return <BasicRideMap {...props} />;
}

function BasicRideMap({ pickup, drop, routeGeometry, pickupLabel, dropLabel, onPick, className }: RideMapProps) {
  const markers = useMemo(() => {
    const out: BasicMarker[] = [];
    if (pickup) out.push({ at: pickup, color: "#1ca65c", label: pickupLabel ? shorten(pickupLabel) : null });
    if (drop) out.push({ at: drop, color: "#e8651a", label: dropLabel ? shorten(dropLabel) : null });
    return out;
  }, [pickup, drop, pickupLabel, dropLabel]);
  return (
    <BasicMap
      markers={markers}
      route={routeGeometry}
      onPick={onPick}
      className={`min-h-[260px] ${className ?? ""}`}
    />
  );
}
