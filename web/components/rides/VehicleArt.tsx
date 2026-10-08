import { useI18n } from "@/components/i18n/I18nContext";
/**
 * Flat side-on drawings of the three vehicle types.
 *
 * The frames put a picture of the vehicle on every fare, which is what makes a
 * list of four near-identical prices scannable: people find the auto by its
 * shape long before they read the word. Drawn here rather than shipped as
 * files so they stay sharp at any size, cost no request, and can be recoloured
 * for dark mode — and because a vehicle photo is a licensing question nobody
 * needs to answer for a shape this simple.
 *
 * Colours are deliberately literal. An auto is yellow and green in every
 * Indian city, and painting it in brand tokens would make it a generic blob.
 * Only the parts with no real-world colour follow the theme.
 */

type Props = { vehicle: string; className?: string };

const WHEEL = "#2f2a26";
const TYRE = "#4a423c";

export function VehicleArt({ vehicle, className }: Props) {
  if (vehicle === "bike") return <Bike className={className} />;
  if (vehicle === "cab") return <Cab className={className} />;
  return <Auto className={className} />;
}

function Auto({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <svg viewBox="0 0 72 48" className={className} role="img" aria-label={t("veh.autoRickshaw")}>
      {/* Canopy and cabin */}
      <path d="M20 12c0-4.4 3.6-8 8-8h10c6.6 0 12 5.4 12 12v10H20V12Z" fill="#f5c518" />
      <path d="M20 12c0-4.4 3.6-8 8-8h10c6.6 0 12 5.4 12 12v3H20v-3Z" fill="#1f7a4d" />
      {/* Windscreen */}
      <path d="M41 9h1.5c3.4 0 6.2 2.6 6.5 6l.2 2H41V9Z" fill="#cfe8f5" />
      {/* Body */}
      <path d="M12 26h44v8a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4v-8Z" fill="#f5c518" />
      <path d="M12 26h44v3H12v-3Z" fill="#1f7a4d" />
      {/* Front cowl */}
      <path d="M12 26c0-5 3-9 7-10v10h-7Z" fill="#f5c518" />
      {/* Wheels */}
      <circle cx="19" cy="38" r="7" fill={WHEEL} />
      <circle cx="19" cy="38" r="2.6" fill="#d9d2cb" />
      <circle cx="48" cy="38" r="7" fill={TYRE} />
      <circle cx="48" cy="38" r="2.6" fill="#d9d2cb" />
    </svg>
  );
}

function Bike({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <svg viewBox="0 0 72 48" className={className} role="img" aria-label={t("veh.motorbike")}>
      {/* Wheels */}
      <circle cx="16" cy="34" r="10" fill="none" stroke={WHEEL} strokeWidth="4" />
      <circle cx="56" cy="34" r="10" fill="none" stroke={WHEEL} strokeWidth="4" />
      {/* Frame */}
      <path
        d="M16 34 30 20h13l6 14"
        fill="none"
        stroke="#e8651a"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M30 20 24 12" fill="none" stroke="#2f2a26" strokeWidth="3.5" strokeLinecap="round" />
      {/* Handlebar */}
      <path d="M19 10h11" stroke="#2f2a26" strokeWidth="3.5" strokeLinecap="round" />
      {/* Seat and tank */}
      <path d="M31 19h13l-2 5H33l-2-5Z" fill="#2f2a26" />
      <path d="M44 16h8a3 3 0 0 1 3 3v3h-9l-2-6Z" fill="#e8651a" />
    </svg>
  );
}

function Cab({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <svg viewBox="0 0 72 48" className={className} role="img" aria-label={t("veh.car")}>
      {/* Roof and cabin */}
      <path d="M22 12h20c3 0 5.8 1.4 7.6 3.8L54 22H18l2.2-7.2A3 3 0 0 1 22 12Z" fill="#3b6ea8" />
      {/* Windows */}
      <path d="M24 15h9v6h-11l2-6Z" fill="#cfe8f5" />
      <path d="M36 15h5.6c2 0 3.9.9 5.1 2.5l2.6 3.5H36v-6Z" fill="#cfe8f5" />
      {/* Body */}
      <path d="M8 22h56a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z" fill="#4a7fbd" />
      <path d="M4 30h64v2a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-2Z" fill="#3b6ea8" />
      {/* Lamps */}
      <rect x="63" y="25" width="5" height="3.5" rx="1.75" fill="#ffe9a8" />
      <rect x="4" y="25" width="4" height="3.5" rx="1.75" fill="#f3b0a0" />
      {/* Wheels */}
      <circle cx="19" cy="36" r="7" fill={WHEEL} />
      <circle cx="19" cy="36" r="2.6" fill="#d9d2cb" />
      <circle cx="53" cy="36" r="7" fill={WHEEL} />
      <circle cx="53" cy="36" r="2.6" fill="#d9d2cb" />
    </svg>
  );
}

/**
 * What a vehicle type means in the things the frames put under the fare.
 *
 * These follow from the vehicle rather than from the provider, so they are
 * stated here once instead of being carried on every quote. Seats are the
 * passenger seats, not counting the driver.
 */
export function vehicleFacts(vehicle: string): { seats: number; ac: boolean } {
  if (vehicle === "bike") return { seats: 1, ac: false };
  if (vehicle === "cab") return { seats: 4, ac: true };
  return { seats: 3, ac: false };
}
