"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { Star, Users, Clock3, Snowflake, Route, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { rupees } from "@/lib/money";
import { PlatformMark } from "@/components/chat/PlatformMark";
import { VehicleArt, vehicleFacts } from "./VehicleArt";
import type { RideQuote } from "@/components/chat/types";

/**
 * The fare the engine is recommending, stated the way the frames state it.
 *
 * A ride is not chosen on price alone, which is why the picture, the wait, the
 * seats and the rating sit together on one card: those are the four things
 * somebody weighs before tapping, and a row that shows only a number makes
 * them open four apps to find the rest.
 */
export function RideBestCard({
  q,
  onSelect,
  busy,
}: {
  q: RideQuote;
  onSelect?: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const { seats, ac } = vehicleFacts(q.vehicle);
  return (
    <div className="overflow-hidden rounded-card border-2 border-accent bg-gradient-to-b from-accent-soft/60 to-card">
      {/* The ribbon, and the reason it earned the place. */}
      <div className="flex items-center justify-between gap-2 bg-accent px-3.5 py-1.5">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-white">
          <Zap size={12} className="fill-white" />
          {t("rd.bestOption")}
        </p>
        {q.badge && (
          <span className="rounded-pill bg-white/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            {q.badge}
          </span>
        )}
      </div>

      <div className="flex items-start gap-3 p-3.5">
        <div className="relative shrink-0">
          <VehicleArt vehicle={q.vehicle} className="h-14 w-20" />
          {/* The driver rating, tucked under the vehicle the way the frame
              has it, so the two are read as one thing. */}
          <span className="absolute -bottom-1 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-pill bg-card px-1.5 py-0.5 text-[10px] font-bold text-ink shadow-soft">
            <Star size={9} className="fill-warning text-warning" />
            {q.driverRating.toFixed(1)}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[15px] font-bold text-ink">{q.displayName}</p>
              <span className="mt-0.5 inline-flex">
                <PlatformMark id={q.provider} />
              </span>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[10px] font-medium uppercase tracking-wide text-cocoa">
                {t("rd.estFare")}
              </p>
              <p className="text-[20px] font-extrabold leading-tight text-accent">
                {rupees(q.effectivePaise)}
              </p>
            </div>
          </div>

          <Facts seats={seats} ac={ac} eta={q.pickupEtaMinutes} trip={q.rideMinutes} />
        </div>
      </div>

      {onSelect && (
        <div className="px-3.5 pb-3.5">
          <button
            onClick={onSelect}
            disabled={busy}
            className="tap-target w-full rounded-pill bg-accent px-4 py-2.5 text-[14px] font-bold text-white transition-opacity disabled:opacity-60"
          >
            {busy ? t("rides.booking") : t("rc.select")}
          </button>
        </div>
      )}
    </div>
  );
}

/** One of the also-rans, in the compact shape the frame lists them in. */
export function RideOptionRow({
  q,
  onSelect,
  busy,
}: {
  q: RideQuote;
  onSelect?: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2.5 rounded-card border border-line bg-card p-2.5">
      <VehicleArt vehicle={q.vehicle} className="h-9 w-12 shrink-0" />

      {/* One column that is allowed to shrink, so the price and the button
          keep their room. Everything here was wrapping onto three lines at
          390px, which is most of the phones this ships to. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <PlatformMark id={q.provider} />
          <p className="min-w-0 truncate text-[13px] font-semibold text-ink">
            {q.displayName}
          </p>
        </div>
        <p className="mt-0.5 flex items-center gap-2 whitespace-nowrap text-[11px] text-cocoa">
          <span className="flex items-center gap-0.5">
            <Clock3 size={10} className="shrink-0" />
            {q.pickupEtaMinutes} {t("u.min")}
          </span>
          <span className="flex items-center gap-0.5">
            <Star size={10} className="shrink-0 fill-warning text-warning" />
            {q.driverRating.toFixed(1)}
          </span>
        </p>
      </div>

      <p className="shrink-0 whitespace-nowrap text-[15px] font-extrabold text-ink">
        {rupees(q.effectivePaise)}
      </p>
      {onSelect && (
        <button
          onClick={onSelect}
          disabled={busy}
          className="tap-target shrink-0 rounded-pill border border-accent px-3 py-1.5 text-[12px] font-bold text-accent transition-colors hover:bg-accent-soft disabled:opacity-60"
        >
          {t("rc.select")}
        </button>
      )}
    </div>
  );
}

function Facts({
  seats,
  ac,
  eta,
  trip,
}: {
  seats: number;
  ac: boolean;
  eta: number;
  trip: number;
}) {
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cocoa">
      <Fact icon={Users} text={`${seats} seat${seats === 1 ? "" : "s"}`} />
      <Fact icon={Clock3} text={`${eta} min away`} />
      {ac && <Fact icon={Snowflake} text="AC" />}
      <Fact icon={Route} text={`${trip} min trip`} />
    </ul>
  );
}

function Fact({ icon: Icon, text }: { icon: typeof Users; text: string }) {
  return (
    <li className="flex items-center gap-1">
      <Icon size={11} className={cn("shrink-0 text-accent")} />
      {text}
    </li>
  );
}
