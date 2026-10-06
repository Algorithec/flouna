"use client";

import { useState } from "react";
import { Zap } from "lucide-react";
import { rupees } from "@/lib/money";

export type Hack = { label: string; detail: string };

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
  if (!quote && hacks.length === 0 && offers.length === 0) return null;

  const visibleOffers = expanded ? offers : offers.slice(0, 2);
  const hasMore = offers.length > 2 && !expanded;

  return (
    <div className="rounded-card border border-accent/30 bg-accent-soft/40 p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-accent">
        <Zap size={12} /> FLOUNA INSIGHTS
      </p>

      {quote && (
        <>
          <p className="mt-2 text-[18px] text-accent/40">{"✦"}</p>
          <p className="mt-1 text-[13px] italic leading-relaxed text-ink">
            &ldquo;{quote}&rdquo;
          </p>
        </>
      )}

      {hacks.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {hacks.map((h) => (
            <div
              key={h.label}
              className="rounded-xl border border-line bg-card px-3 py-2.5"
            >
              <p className="text-[13px] font-bold text-ink">{h.label}</p>
              <p className="mt-0.5 text-[12px] leading-snug text-cocoa">
                {"→"} {h.detail}
              </p>
            </div>
          ))}
        </div>
      )}

      {offers.length > 0 && (
        <div className="mt-3">
          <p className="text-[13px] font-bold text-ink">
            Available offers and coupons
          </p>
          <div className="mt-1.5 flex flex-col gap-1">
            {visibleOffers.map((o) => (
              <p
                key={o.label}
                className="flex items-start gap-2 text-[12px] text-ink"
              >
                <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-ink" />
                <span>
                  {o.label}
                  {o.discountPaise > 0 && (
                    <span className="text-cocoa">
                      {" "}&middot; saves {rupees(o.discountPaise)}
                    </span>
                  )}
                </span>
              </p>
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => setExpanded(true)}
              className="mt-2.5 rounded-lg border border-ink/70 px-3.5 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:bg-card"
            >
              MORE
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
    label: "Ride hack",
    detail: `Switch to ${cheapest.vehicle} and save ${rupees(saving)} on this trip.`,
  };
}

export function bundleHack(
  addOns: { name: string; pricePaise: number }[],
  bundleDiscountPaise: number,
): Hack | null {
  if (addOns.length === 0 || bundleDiscountPaise <= 0) return null;
  const names = addOns.map((a) => a.name).join(" + ");
  return {
    label: "Bundle deal",
    detail: `Add ${names} and save ${rupees(bundleDiscountPaise)} on this order.`,
  };
}
