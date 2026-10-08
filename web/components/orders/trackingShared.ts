// Progress along a route, and the vehicle drawn at the head of it. Shared by
// the tracking map on both engines, so they agree about how far a ride has got.

// Haversine distance in metres between two [lng,lat] points.
function dist(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function totalLength(geom: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < geom.length; i++) len += dist(geom[i - 1]!, geom[i]!);
  return len;
}

// Fraction (0→1) along the polyline nearest to point `p` — used to know how
// much of the route the driver has covered, for the solid "done" overlay.
export function fractionAt(geom: [number, number][], p: [number, number]): number {
  const total = totalLength(geom);
  if (total === 0) return 0;
  let acc = 0;
  let best = { d: Infinity, len: 0 };
  for (let i = 1; i < geom.length; i++) {
    const a = geom[i - 1]!;
    const b = geom[i]!;
    const seg = dist(a, b);
    // Project p onto segment a→b in lat/lng space (good enough at city scale).
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const proj: [number, number] = [a[0] + dx * t, a[1] + dy * t];
    const d = dist(p, proj);
    if (d < best.d) best = { d, len: acc + seg * t };
    acc += seg;
  }
  return Math.max(0, Math.min(1, best.len / total));
}

// The portion of the route from the start up to fraction `t`.
export function sliceRoute(geom: [number, number][], t: number): [number, number][] {
  if (t <= 0) return [geom[0]!, geom[0]!];
  if (t >= 1) return geom;
  const target = totalLength(geom) * t;
  const out: [number, number][] = [geom[0]!];
  let acc = 0;
  for (let i = 1; i < geom.length; i++) {
    const seg = dist(geom[i - 1]!, geom[i]!);
    if (acc + seg >= target) {
      const f = seg === 0 ? 0 : (target - acc) / seg;
      const a = geom[i - 1]!;
      const b = geom[i]!;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      break;
    }
    out.push(geom[i]!);
    acc += seg;
  }
  return out;
}

// Scooter glyph for food deliveries — the partner is on two wheels, not in a cab.
export function bikeSvg(): string {
  return `
  <span style="display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:#3d1c00;box-shadow:0 4px 12px rgba(61,28,0,0.4);border:3px solid #fff;">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/>
      <path d="M12 17.5h-3l1.5-5h5"/><path d="M15.5 12.5 13 7h-2.5"/><path d="M18.5 17.5 15.5 12.5"/>
      <path d="M13 7h2l1 2.5"/>
    </svg>
  </span>`;
}

export function carSvg(): string {
  return `
  <span style="display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:#3d1c00;box-shadow:0 4px 12px rgba(61,28,0,0.4);border:3px solid #fff;">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/>
      <circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>
    </svg>
  </span>`;
}
