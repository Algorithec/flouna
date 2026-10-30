"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/components/i18n/I18nContext";

// The map drawn when Google Maps is not available: no key set, the key
// refused, or the script blocked. It needs nothing from outside, so the app
// keeps working with no keys at all and on a network that blocks Google.
//
// It draws only what we know (the points, the route and how much of it is
// covered) on a plain grid, with no tiles and so no licence or key. Tapping it
// picks the point under the finger within the area shown, which is enough to
// move a pin or choose a pickup in the offline demo.

export type LatLng = { lat: number; lng: number };

export type BasicMarker = {
  at: LatLng;
  color: string;
  label?: string | null;
  /** A vehicle is drawn as a ring, so it stands apart from the two ends. */
  vehicle?: boolean;
};

// Hyderabad, where the offline places are: the view when there is nothing to show.
const DEFAULT_CENTER: LatLng = { lat: 17.385, lng: 78.4867 };
const MIN_SPAN_DEG = 0.01;
const GRID_PX = 32;

type View = { minLat: number; maxLat: number; minLng: number; maxLng: number };

/**
 * The area to show for a frame of w by h pixels: every point and the route,
 * padded, never tighter than about a kilometre, in the frame's own proportions
 * so nothing is squashed and the grid fills it edge to edge.
 */
function viewFor(points: LatLng[], center: LatLng | null, spanKm: number, w: number, h: number): View {
  let minLat: number, maxLat: number, minLng: number, maxLng: number;
  if (center || points.length === 0) {
    const c = center ?? DEFAULT_CENTER;
    const half = spanKm / 2 / 111;
    const halfLng = half / Math.cos((c.lat * Math.PI) / 180);
    [minLat, maxLat, minLng, maxLng] = [c.lat - half, c.lat + half, c.lng - halfLng, c.lng + halfLng];
  } else {
    minLat = Math.min(...points.map((p) => p.lat));
    maxLat = Math.max(...points.map((p) => p.lat));
    minLng = Math.min(...points.map((p) => p.lng));
    maxLng = Math.max(...points.map((p) => p.lng));
  }
  const midLat = (minLat + maxLat) / 2;
  const midLng = (minLng + maxLng) / 2;
  // A degree of longitude is shorter than a degree of latitude away from the
  // equator; without this the map would be stretched sideways.
  const kx = Math.cos((midLat * Math.PI) / 180);
  let latSpan = Math.max(maxLat - minLat, MIN_SPAN_DEG);
  let lngSpan = Math.max((maxLng - minLng) * kx, MIN_SPAN_DEG);
  if (lngSpan / latSpan < w / h) lngSpan = (latSpan * w) / h;
  else latSpan = (lngSpan * h) / w;
  // Room around the points for their names and the map's own edges.
  const pad = center ? 1 : 1.5;
  latSpan *= pad;
  lngSpan *= pad;
  return {
    minLat: midLat - latSpan / 2,
    maxLat: midLat + latSpan / 2,
    minLng: midLng - lngSpan / kx / 2,
    maxLng: midLng + lngSpan / kx / 2,
  };
}

/** [lng, lat] pairs, as the server sends routes. */
function toLatLng(geometry: [number, number][] | null | undefined): LatLng[] {
  return (geometry ?? []).map(([lng, lat]) => ({ lat, lng }));
}

export function BasicMap({
  markers,
  route,
  covered,
  center = null,
  spanKm = 3,
  onPick,
  className,
}: {
  markers: BasicMarker[];
  /** The whole route, [lng, lat] pairs. */
  route?: [number, number][] | null;
  /** The part already travelled, drawn solid over the route. */
  covered?: [number, number][] | null;
  /** When set, the view is this point and the area around it, as in the location picker. */
  center?: LatLng | null;
  spanKm?: number;
  onPick?: ((p: LatLng) => void) | null;
  className?: string;
}) {
  const { t } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });

  // Drawn at the frame's real size, so lines and labels stay crisp and the
  // map fills a tall phone screen as well as a wide desktop pane.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const routePts = useMemo(() => toLatLng(route), [route]);
  const coveredPts = useMemo(() => toLatLng(covered), [covered]);
  const view = useMemo(
    () => viewFor([...markers.map((m) => m.at), ...routePts], center, spanKm, w, h),
    [markers, routePts, center, spanKm, w, h],
  );
  const project = (p: LatLng): [number, number] => [
    ((p.lng - view.minLng) / (view.maxLng - view.minLng)) * w,
    ((view.maxLat - p.lat) / (view.maxLat - view.minLat)) * h,
  ];
  const line = (pts: LatLng[]) => pts.map((p) => project(p).join(",")).join(" ");

  function pick(e: React.PointerEvent<HTMLDivElement>) {
    const el = boxRef.current;
    if (!onPick || !el) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * w;
    const y = ((e.clientY - r.top) / r.height) * h;
    onPick({
      lat: view.maxLat - (y / h) * (view.maxLat - view.minLat),
      lng: view.minLng + (x / w) * (view.maxLng - view.minLng),
    });
  }

  return (
    <div
      ref={boxRef}
      data-map="basic"
      className={`relative size-full overflow-hidden bg-beige/40 ${onPick ? "cursor-crosshair" : ""} ${className ?? ""}`}
      onPointerUp={onPick ? pick : undefined}
    >
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={t("map.basicLabel")} className="absolute inset-0">
        <defs>
          <pattern id="basic-map-grid" width={GRID_PX} height={GRID_PX} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID_PX} 0 L 0 0 0 ${GRID_PX}`} fill="none" stroke="currentColor" strokeWidth="1" className="text-line" />
          </pattern>
        </defs>
        <rect width={w} height={h} fill="url(#basic-map-grid)" />
        {routePts.length > 1 && (
          <polyline
            points={line(routePts)}
            fill="none"
            stroke="#e8651a"
            strokeOpacity={0.35}
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {coveredPts.length > 1 && (
          <polyline
            points={line(coveredPts)}
            fill="none"
            stroke="#e8651a"
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {markers.map((m, i) => {
          const [x, y] = project(m.at);
          return (
            <g key={i}>
              {m.vehicle ? (
                <>
                  <circle cx={x} cy={y} r={11} fill="#fff" stroke={m.color} strokeWidth={3} />
                  <circle cx={x} cy={y} r={4} fill={m.color} />
                </>
              ) : (
                <circle cx={x} cy={y} r={8} fill={m.color} stroke="#fff" strokeWidth={3} />
              )}
              {m.label && (
                <text
                  x={x}
                  y={y - 15}
                  textAnchor="middle"
                  fontSize={13}
                  fontWeight={600}
                  className="fill-ink"
                  paintOrder="stroke"
                  stroke="#fff"
                  strokeWidth={4}
                >
                  {m.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <span className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-card/80 px-1.5 py-0.5 text-[10px] text-cocoa">
        {t("map.basic")}
      </span>
    </div>
  );
}
