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
  const [failed, setFailed] = useState(false);

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

    void (async () => {
      const dest = await locate(drop);
      if (!active) return;
      if (dest) setTo(dest);

      const origin = await locate(pickup);
      if (!active) return;
      if (origin) setFrom(origin);

      if (!dest && !origin) setFailed(true);
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

  if (failed || (!pickupPt && !dropPt)) {
    return (
      <div className="flex h-[120px] items-center justify-center rounded-[18px] border border-line bg-beige/30 text-[13px] text-cocoa">
        Route map unavailable
      </div>
    );
  }

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
