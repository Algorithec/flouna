"use client";

import { ShieldCheck, Clock3, Route, Tag, ChevronRight, ArrowLeft } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nContext";
import { rupees } from "@/lib/money";
import { VehicleArt } from "./VehicleArt";
import type { RideQuote } from "@/components/chat/types";

/**
 * The last screen before a ride is booked.
 *
 * Booking used to happen on the same tap that chose a fare, which meant the
 * only place the distance, the trip time and the total appeared together was
 * after the money had moved. Those are exactly the three numbers somebody
 * checks before agreeing, so they get a screen of their own.
 *
 * The fare is the one already quoted, not a fresh calculation. Recomputing it
 * here would let the number move between choosing and confirming, which is the
 * one thing a confirmation screen must never do.
 */
export function TripSummary({
  quote,
  pickup,
  drop,
  distanceKm,
  rideMinutes,
  onEditPickup,
  onEditDrop,
  onBack,
  onConfirm,
  busy,
}: {
  quote: RideQuote;
  pickup: string;
  drop: string;
  distanceKm: number;
  rideMinutes: number;
  onEditPickup?: () => void;
  onEditDrop?: () => void;
  onBack: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="tap-target -ml-1 rounded-full p-1.5 text-cocoa hover:bg-beige"
          aria-label={t("ts.backToFares")}
        >
          <ArrowLeft size={17} />
        </button>
        <p className="text-[15px] font-bold text-ink">{t("ts.title")}</p>
      </div>

      {/* Both ends, each changeable from here. Discovering a wrong pickup at
          the confirmation step and having to start over is the reason people
          abandon a booking. */}
      <div className="overflow-hidden rounded-card border border-line">
        <Endpoint colour="#1ca65c" label={t("bill.pickup")} value={pickup} onEdit={onEditPickup} />
        <div className="h-px bg-line" />
        <Endpoint colour="#e8651a" label={t("bill.drop")} value={drop} onEdit={onEditDrop} />
      </div>

      <div className="overflow-hidden rounded-card border border-line">
        <Row
          icon={<VehicleArt vehicle={quote.vehicle} className="h-5 w-7" />}
          label={t("ts.rideType")}
          value={quote.displayName}
        />
        <div className="h-px bg-line" />
        <Row icon={<Clock3 size={15} className="text-accent" />} label={t("ts.estTime")} value={`${rideMinutes} min`} />
        <div className="h-px bg-line" />
        <Row icon={<Route size={15} className="text-accent" />} label={t("ts.distance")} value={`${distanceKm.toFixed(1)} km`} />
        <div className="h-px bg-line" />
        <Row
          icon={<ShieldCheck size={15} className="text-success" />}
          label={t("ts.safety")}
          value={t("ts.safetyValue")}
          quiet
        />
      </div>

      <div className="rounded-card border border-accent/40 bg-accent-soft/40 p-3.5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[12px] font-semibold text-cocoa">{t("ts.estFare")}</p>
            <p className="text-[11px] text-cocoa">{t("ts.inclTaxes")}</p>
          </div>
          <p className="text-[24px] font-extrabold leading-none text-accent">
            {rupees(quote.effectivePaise)}
          </p>
        </div>

        {quote.offers.length > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] font-semibold text-success">
            <Tag size={12} />
            {quote.offers[0]!.label} ·{" "}
            {t("ts.saves").replace("{amount}", rupees(quote.offers[0]!.discountPaise))}
          </p>
        )}
      </div>

      {/* Said before confirming rather than after, because "where is my
          driver" is the first thing asked otherwise. */}
      <p className="text-[12px] leading-relaxed text-cocoa">
        {t("ts.driverAfter")}
      </p>

      <button
        onClick={onConfirm}
        disabled={busy}
        className="tap-target w-full rounded-pill bg-accent px-4 py-3 text-[15px] font-bold text-white transition-opacity disabled:opacity-60"
      >
        {busy
          ? t("ts.confirming")
          : t("ts.confirmRide").replace("{amount}", rupees(quote.effectivePaise))}
      </button>
    </div>
  );
}

function Endpoint({
  colour,
  label,
  value,
  onEdit,
}: {
  colour: string;
  label: string;
  value: string;
  onEdit?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2.5 bg-card px-3.5 py-3">
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: colour }} />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-cocoa">{label}</p>
        <p className="truncate text-[14px] font-semibold text-ink">{value}</p>
      </div>
      {onEdit && (
        <button
          onClick={onEdit}
          className="tap-target shrink-0 text-[12px] font-bold text-accent hover:underline"
        >
          {t("ts.edit")}
        </button>
      )}
    </div>
  );
}

function Row({
  icon,
  label,
  value,
  quiet,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  quiet?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 bg-card px-3.5 py-2.5">
      <span className="flex w-7 shrink-0 justify-center">{icon}</span>
      <p className="flex-1 text-[13px] text-cocoa">{label}</p>
      <p className={quiet ? "text-[12px] text-cocoa" : "text-[13px] font-bold text-ink"}>
        {value}
      </p>
      {!quiet && <ChevronRight size={0} className="hidden" />}
    </div>
  );
}
