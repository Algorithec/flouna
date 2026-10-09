"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { Bike, Car, Star, Users, Clock3, Snowflake, Route, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { rupees } from "@/lib/money";
import { PlatformChip } from "@/components/chat/PlatformMark";
import { VehicleArt, vehicleFacts } from "./VehicleArt";
import type { RideQuote } from "@/components/chat/types";

export function VehicleTabs({
  vehicles,
  value,
  onChange,
}: {
  vehicles: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const order = ["bike", "cab", "auto", "any"];
  const shown = order.filter((v) => vehicles.includes(v));
  if (shown.length <= 1) return null;

  return (
    <div className="flex gap-1.5 rounded-[18px] bg-[#ebe6e0] p-1.5">
      {shown.map((v) => {
        const selected = v === value;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 rounded-[14px] py-2.5 transition-colors",
              selected
                ? "border-[1.5px] border-ink/70 bg-card text-ink shadow-soft"
                : "text-[#9a9590]",
            )}
          >
            <VehicleTabIcon vehicle={v} selected={selected} />
            <span className="text-[12px] font-semibold capitalize">{v}</span>
          </button>
        );
      })}
    </div>
  );
}

function VehicleTabIcon({ vehicle, selected }: { vehicle: string; selected: boolean }) {
  const color = selected ? "#e8651a" : "#9a9590";
  if (vehicle === "bike") return <Bike size={22} color={color} strokeWidth={1.75} />;
  if (vehicle === "cab") return <Car size={22} color={color} strokeWidth={1.75} />;
  if (vehicle === "any") return <Zap size={22} color={color} strokeWidth={1.75} />;
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 18h8.5a3.5 3.5 0 0 0 0-7H14l-1.5-5H8L7 11H5.5A2.5 2.5 0 0 0 3 13.5V16a2 2 0 0 0 2 2h2Z"
        stroke={color}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="18" r="1.6" fill={color} />
      <circle cx="16.5" cy="18" r="1.6" fill={color} />
    </svg>
  );
}

export function ProvidersHeader({ count }: { count: number }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-[16px] font-bold text-ink">{t("rc.availableProviders")}</p>
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fff1e8] px-2.5 py-1 text-[12px] font-semibold text-accent">
        <Zap size={13} className="fill-accent" />
        {count === 1
          ? t("rc.oneOptionFound")
          : t("rc.optionsFound").replace("{n}", String(count))}
      </span>
    </div>
  );
}

/**
 * The fare the engine is recommending, stated the way the frames state it.
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
    <div className="rounded-[18px] border border-accent/40 bg-gradient-to-b from-[#fff1e8] to-card p-3.5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="flex w-[4.75rem] shrink-0 flex-col items-center">
          <span className="inline-flex items-center gap-0.5 rounded-md bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
            <Zap size={9} className="fill-white" />
            {t("rd.bestOption")}
          </span>
          <VehicleArt vehicle={q.vehicle} className="mt-2 h-11 w-[4.4rem]" />
          <span className="mt-1 flex items-center gap-0.5 text-[11px] font-bold text-ink">
            <Star size={11} className="fill-[#f5a524] text-[#f5a524]" />
            {q.driverRating.toFixed(1)}
          </span>
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-[16px] font-bold capitalize text-ink">
              {q.displayName || q.vehicle}
            </p>
            {q.badge && (
              <span className="rounded-md bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                {q.badge}
              </span>
            )}
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11.5px] text-cocoa">
            <Fact
              icon={Users}
              text={
                seats === 1
                  ? t("rd.seat")
                  : t("rd.seats").replace("{n}", String(seats))
              }
            />
            <Fact
              icon={Clock3}
              text={t("rd.minAway").replace("{n}", String(q.pickupEtaMinutes))}
            />
            {ac && <Fact icon={Snowflake} text={t("rd.ac")} />}
            <Fact
              icon={Route}
              text={t("rd.minTrip").replace("{n}", String(q.rideMinutes))}
            />
          </ul>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2 pt-0.5">
          <div className="text-right">
            <p className="text-[10px] font-medium text-cocoa">{t("rd.estFare")}</p>
            <p className="text-[22px] font-extrabold leading-tight text-ink">
              {rupees(q.effectivePaise)}
            </p>
          </div>
          {onSelect && (
            <button
              onClick={onSelect}
              disabled={busy}
              className="tap-target rounded-full bg-accent px-5 py-2 text-[13px] font-bold text-white transition-opacity disabled:opacity-60"
            >
              {busy ? t("rides.booking") : t("rc.select")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
    <div className="flex items-center gap-2.5 rounded-[18px] border border-line bg-card px-3 py-2.5 shadow-soft">
      <VehicleArt vehicle={q.vehicle} className="h-10 w-14 shrink-0" />

      <div className="min-w-0 flex-1">
        <PlatformChip id={q.provider} variant="outline" />
        <p className="mt-0.5 truncate text-[13px] font-medium text-ink">{q.displayName}</p>
      </div>

      <p className="shrink-0 text-[18px] font-extrabold text-ink">
        {rupees(q.effectivePaise)}
      </p>
      {onSelect && (
        <button
          onClick={onSelect}
          disabled={busy}
          className="tap-target shrink-0 rounded-full border border-accent px-3.5 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accent-soft disabled:opacity-60"
        >
          {t("rc.select")}
        </button>
      )}
    </div>
  );
}

function Fact({ icon: Icon, text }: { icon: typeof Users; text: string }) {
  return (
    <li className="flex items-center gap-1">
      <Icon size={12} className="shrink-0 text-accent" />
      {text}
    </li>
  );
}
