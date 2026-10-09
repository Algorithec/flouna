"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { rupees } from "@/lib/money";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";

/**
 * A suggestion, as keys and the values to put in them. Built outside any
 * component, where the language is not known, and worded when shown.
 */
export type Hack = { label: TranslationKey; detail: TranslationKey; vars: Record<string, string> };

function fill(template: string, vars: Record<string, string>) {
  return Object.entries(vars).reduce((text, [k, v]) => text.replace(`{${k}}`, v), template);
}

export function FlounaInsights({
  quote,
  hacks = [],
  offers = [],
}: {
  quote?: string | null;
  hacks?: Hack[];
  offers?: { label: string; discountPaise: number }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  if (!quote && hacks.length === 0 && offers.length === 0) return null;

  const visibleOffers = expanded ? offers : offers.slice(0, 2);
  const hasMore = offers.length > 2 && !expanded;
  const isRide = hacks.some((h) => h.label === "fi.rideHack");
  const payment = isRide ? offers[0] : undefined;
  const tileCount = hacks.length + (payment ? 1 : 0);
  const listOffers = isRide ? [] : offers;
  const listed = isRide ? [] : visibleOffers;

  return (
    <div className="rounded-[18px] border border-accent/30 bg-[#fff1e8] p-3.5">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-accent">
        <Sparkles size={12} /> {t("rc.insights")}
      </p>

      {quote && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-ink">
          &ldquo;{quote}&rdquo;
        </p>
      )}

      {isRide && tileCount > 0 && (
        <div className={`mt-3 grid gap-2 ${tileCount > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {hacks.map((h) => (
            <div
              key={h.label}
              className="rounded-[14px] border border-line/90 bg-card px-3 py-2.5"
            >
              <p className="text-[13px] font-bold text-ink">{t(h.label)}</p>
              <p className="mt-0.5 text-[12px] leading-snug text-cocoa">
                {fill(t(h.detail) as string, h.vars)}
              </p>
            </div>
          ))}
          {payment && (
            <div className="rounded-[14px] border border-line/90 bg-card px-3 py-2.5">
              <p className="text-[13px] font-bold text-ink">{t("fi.bestPayment")}</p>
              <p className="mt-0.5 text-[12px] leading-snug text-cocoa">
                {payment.label}
                {payment.discountPaise > 0 && ` ${rupees(payment.discountPaise)}`}
              </p>
            </div>
          )}
        </div>
      )}

      {!isRide && hacks.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {hacks.map((h) => (
            <div key={h.label}>
              <p className="text-[13px] font-bold text-ink">{t(h.label)}</p>
              <p className="mt-0.5 text-[12.5px] leading-snug text-ink/85">
                → {fill(t(h.detail) as string, h.vars)}
              </p>
            </div>
          ))}
        </div>
      )}

      {listOffers.length > 0 && (
        <div className="mt-3">
          <p className="text-[13px] font-bold text-ink">{t("fi.offers")}</p>
          <div className="mt-1.5 flex flex-col gap-1">
            {listed.map((o) => (
              <p key={o.label} className="flex items-start gap-2 text-[12px] text-ink">
                <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-ink" />
                <span>
                  {o.label}
                  {o.discountPaise > 0 && (
                    <span className="text-cocoa">
                      {" "}
                      &middot; {t("ts.saves").replace("{amount}", rupees(o.discountPaise))}
                    </span>
                  )}
                </span>
              </p>
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => setExpanded(true)}
              className="mt-2.5 rounded-lg border border-ink/70 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink transition-colors hover:bg-card"
            >
              {t("fi.more")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function cheaperVehicleHack(
  best: { vehicle: string; effectivePaise: number },
  alternatives: { vehicle: string; effectivePaise: number; displayName: string }[],
): Hack | null {
  const MIN_WORTH_SAYING = 1000;
  let cheapest: (typeof alternatives)[number] | null = null;
  for (const a of alternatives) {
    if (a.vehicle === best.vehicle) continue;
    if (a.effectivePaise >= best.effectivePaise) continue;
    if (!cheapest || a.effectivePaise < cheapest.effectivePaise) cheapest = a;
  }
  if (!cheapest) return null;
  const saving = best.effectivePaise - cheapest.effectivePaise;
  if (saving < MIN_WORTH_SAYING) return null;
  return {
    label: "fi.rideHack",
    detail: "fi.rideHackDetail",
    vars: { vehicle: cheapest.vehicle, amount: rupees(saving) },
  };
}

export function bundleHack(
  addOns: { name: string; pricePaise: number }[],
  bundleDiscountPaise: number,
): Hack | null {
  if (addOns.length === 0 || bundleDiscountPaise <= 0) return null;
  const names = addOns.map((a) => a.name).join(" + ");
  return {
    label: "fi.bundle",
    detail: "fi.bundleDetail",
    vars: { names, amount: rupees(bundleDiscountPaise) },
  };
}
