"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import { resolvePlace, searchPlaces } from "@/lib/places";
import type { LatLng } from "./RideMap";

const RideMap = dynamic(() => import("./RideMap").then((m) => m.RideMap), {
  ssr: false,
  loading: () => <div className="h-full animate-pulse bg-beige/50" />,
});

type Place = { name: string; lat: number; lng: number };

/**
 * Compact route map for ride recommendations.
 *
 * Uses the same map engine and geocoding as booking. It only draws the trip
 * the recommendation already named — it does not price or book.
 */
export function RideResultMap({
  pickup,
  drop,
  providers = [],
}: {
  pickup?: string | null;
  drop?: string | null;
  providers?: string[];
}) {
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [geometry, setGeometry] = useState<[number, number][] | null>(null);

  useEffect(() => {
    let active = true;

    async function locate(query: string | null | undefined): Promise<Place | null> {
      const q = query?.trim();
      if (!q) return null;
      try {
        const first = (await searchPlaces(q))[0];
        const place = first ? await resolvePlace(first) : null;
        if (!place) return null;
        return { name: place.name, lat: place.lat, lng: place.lng };
      } catch {
        return null;
      }
    }

    async function here(): Promise<Place | null> {
      if (!navigator.geolocation) return null;
      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({
              name: pickup?.trim() || "",
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
            }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
        );
      });
    }

    void (async () => {
      const dest = await locate(drop);
      if (!active) return;
      if (dest) setTo(dest);

      const origin = (await locate(pickup)) ?? (await here());
      if (!active) return;
      if (origin) setFrom(origin);
    })();

    return () => {
      active = false;
    };
  }, [pickup, drop]);

  useEffect(() => {
    if (!from || !to) return;
    let active = true;
    api<{ geometry: [number, number][] | null }>(
      `/api/rides/route?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${to.lat}&toLng=${to.lng}`,
    )
      .then((r) => {
        if (active) setGeometry(r.geometry ?? null);
      })
      .catch(() => {
        if (active) setGeometry(null);
      });
    return () => {
      active = false;
    };
  }, [from, to]);

  const pickupPt: LatLng | null = from ? { lat: from.lat, lng: from.lng } : null;
  const dropPt: LatLng | null = to ? { lat: to.lat, lng: to.lng } : null;
  if (!pickupPt && !dropPt) return null;

  return (
    <div className="overflow-hidden rounded-[18px] border border-line shadow-soft">
      <div className="h-[220px] lg:h-[260px]">
        <RideMap
          pickup={pickupPt}
          drop={dropPt}
          routeGeometry={geometry}
          pickupLabel={from?.name || pickup || null}
          dropLabel={to?.name || drop || null}
          providers={providers}
          className="!min-h-0 h-full"
        />
      </div>
    </div>
  );
}
