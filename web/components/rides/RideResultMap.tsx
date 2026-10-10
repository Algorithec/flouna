"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import { useI18n } from "@/components/i18n/I18nContext";
import { newSearchSession, resolvePlace, searchPlaces } from "@/lib/places";
import type { LatLng } from "./RideMap";

const RideMap = dynamic(() => import("./RideMap").then((m) => m.RideMap), {
  ssr: false,
  loading: () => <div className="h-full animate-pulse bg-beige/50" />,
});

type Place = { name: string; lat: number; lng: number };

// Resolve an endpoint name to coordinates once per page, not once per card.
//
// This map renders under every ride recommendation, and a conversation holds
// many of them. Each resolution is an Autocomplete call plus a Place Details
// call, so an uncached card bought the same pickup and the same drop again on
// every mount. The two calls are billed as one lookup only when they carry
// the same session token, which is why the token is created here and passed
// to both rather than left off.
//
// The promise is cached, not the value, so two cards mounting together share
// one request instead of racing. A failure is dropped from the cache so a
// later card retries rather than inheriting an outage for the whole session.
const placeRequests = new Map<string, Promise<Place | null>>();

function locatePlace(query: string): Promise<Place | null> {
  const key = query.toLowerCase();
  let pending = placeRequests.get(key);
  if (!pending) {
    pending = (async () => {
      const session = newSearchSession();
      const first = (await searchPlaces(query, { session }))[0];
      if (!first) return null;
      const place = await resolvePlace(first, session);
      return place ? { name: place.name, lat: place.lat, lng: place.lng } : null;
    })().catch(() => {
      placeRequests.delete(key);
      return null;
    });
    placeRequests.set(key, pending);
  }
  return pending;
}

// Same reasoning for the route: the geometry between one pair of coordinates
// is the same drawing for every card that shows that trip.
const routeRequests = new Map<string, Promise<[number, number][] | null>>();

function locateRoute(from: Place, to: Place): Promise<[number, number][] | null> {
  const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`;
  let pending = routeRequests.get(key);
  if (!pending) {
    pending = api<{ geometry: [number, number][] | null }>(
      `/api/rides/route?fromLat=${from.lat}&fromLng=${from.lng}&toLat=${to.lat}&toLng=${to.lng}`,
    )
      .then((r) => r.geometry ?? null)
      .catch(() => {
        routeRequests.delete(key);
        return null;
      });
    routeRequests.set(key, pending);
  }
  return pending;
}

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
  const { t } = useI18n();
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [geometry, setGeometry] = useState<[number, number][] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;

    function locate(query: string | null | undefined): Promise<Place | null> {
      const q = query?.trim();
      if (!q) return Promise.resolve(null);
      return locatePlace(q);
    }

    void (async () => {
      const [origin, dest] = await Promise.all([locate(pickup), locate(drop)]);
      if (!active) return;
      setFrom(origin);
      setTo(dest);
      // Recomputed, not latched. It used to only ever be set to true, so one
      // failed geocode left this card showing the fallback for good — even
      // after new props resolved perfectly well.
      setFailed(!origin && !dest);
    })();

    return () => {
      active = false;
    };
  }, [pickup, drop]);

  useEffect(() => {
    if (!from || !to) return;
    let active = true;
    void locateRoute(from, to).then((g) => {
      if (active) setGeometry(g);
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
        {t("rd.mapUnavailable")}
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
