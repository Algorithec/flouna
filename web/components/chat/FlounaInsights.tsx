"use client";

import { useState } from "react";
import { Zap, Tag, CircleCheck, ChevronDown, ChevronUp } from "lucide-react";
import { rupees } from "@/lib/money";

// The insights panel from the design: the review, the cheaper route through the
// same order, and the offers already applied.
//
// Every tile here is derived from the quotes we actually hold. The design also
// shows a payment-cashback tile and a bundle tile, and neither has any data
// behind it yet, so neither is invented here. A panel headed "insights" that
// makes up a ₹40 cashback is worse than one tile shorter, because the whole
// point of it is that the numbers can be trusted.
//
// Rendered at both sizes. It used to be desktop only, which dropped it on the
// size most people use.

export type Hack = { label: string; detail: string };

// Above this many hacks+offers combined, the panel collapses behind "MORE" —
// mirrors the mock, and keeps a long insights list from pushing the answer
// (and the composer) off a phone screen.
const COLLAPSE_AFTER = 2;

export function FlounaInsights({
  quote,
  hacks = [],
  offers = [],
}: {
  /** A real review of the winning option, when there is one. */
  quote?: string | null;
  /** Cheaper or faster ways through the same order, worked out from the quotes. */
  hacks?: Hack[];
  offers?: { label: string; discountPaise: number }[];
}) {
  const [expanded, setExpanded] = useState(false);

  if (!quote && hacks.length === 0 && offers.length === 0) return null;

  const totalTiles = hacks.length + offers.length;
  const collapsible = totalTiles > COLLAPSE_AFTER;
  // Hacks read first, so if something has to hide behind "MORE" it's the
  // longer, less decision-critical offers list rather than a hack that might
  // change what someone orders.
  const visibleHacks = collapsible && !expanded ? hacks.slice(0, COLLAPSE_AFTER) : hacks;
  const remainingSlots = collapsible && !expanded ? Math.max(0, COLLAPSE_AFTER - visibleHacks.length) : offers.length;
  const visibleOffers = collapsible && !expanded ? offers.slice(0, remainingSlots) : offers;
  const hiddenCount = totalTiles - visibleHacks.length - visibleOffers.length;

  return (
    <div className="rounded-card border border-accent/30 bg-accent-soft/40 p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-accent">
        <Zap size={12} /> FLOUNA INSIGHTS
      </p>

      {quote && (
        <p className="mt-2 text-[13px] italic leading-relaxed text-ink">
          “{quote}”
        </p>
      )}

      {visibleHacks.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {visibleHacks.map((h) => (
            <div
              key={h.label}
              className="rounded-xl border border-line bg-card px-3 py-2.5"
            >
              <p className="text-[12px] font-bold text-ink">{h.label}</p>
              <p className="mt-0.5 text-[12px] leading-snug text-cocoa">
                {h.detail}
              </p>
            </div>
          ))}
        </div>
      )}

      {visibleOffers.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-success">
            <Tag size={13} /> Available offers and coupons
          </p>
          <div className="mt-1.5 flex flex-col gap-1">
            {visibleOffers.map((o) => (
              <p
                key={o.label}
                className="flex items-center gap-1.5 text-[12px] text-ink"
              >
                <CircleCheck size={13} className="shrink-0 text-success" />
                {o.label}
                {o.discountPaise > 0 && (
                  <span className="text-cocoa">
                    · saves {rupees(o.discountPaise)}
                  </span>
                )}
              </p>
            ))}
          </div>
        </div>
      )}

      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="tap-target mt-3 flex items-center gap-1 text-[12px] font-bold text-accent"
        >
          {expanded ? (
            <>
              LESS <ChevronUp size={13} />
            </>
          ) : (
            <>
              MORE {hiddenCount > 0 ? `(${hiddenCount})` : ""} <ChevronDown size={13} />
            </>
          )}
        </button>
      )}
    </div>
  );
}

/**
 * "Switch to a bike and save ₹10", worked out rather than written.
 *
 * Only offered when the cheaper option is a genuinely different vehicle and the
 * saving is worth a sentence. Suggesting somebody downgrade to save one rupee
 * wastes the one tile they will read.
 */
export function cheaperVehicleHack(
  best: { vehicle: string; effectivePaise: number },
  alternatives: { vehicle: string; effectivePaise: number; displayName: string }[],
): Hack | null {
  const MIN_WORTH_SAYING = 1000; // ₹10 in paise
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

/**
 * "Add Coke + Dessert → Save ₹80" — the food-side equivalent of
 * `cheaperVehicleHack`, following the same rule: it only exists when there is
 * a real add-on with a real bundled discount behind it.
 *
 * NOTE ON DATA: `FoodQuote` (web/components/chat/types.ts) does not currently
 * carry a restaurant's add-on/combo catalogue — only the dish that was
 * ordered. So this function takes that catalogue as an explicit argument
 * rather than inventing "Coke" and "Dessert" out of nothing. Until the
 * backend/API returns real add-ons for the winning restaurant (e.g. from the
 * menu endpoint), call sites simply won't have anything to pass in, and the
 * hack correctly won't render — the same way `FlounaInsights` already omits
 * the payment-cashback tile it has no data for. Wire this up once the menu
 * endpoint exposes add-ons; don't fake the addOns array to make the tile
 * appear.
 */
export function bundleHack(
  addOns: { name: string; pricePaise: number }[],
  bundleDiscountPaise: number,
): Hack | null {
  if (addOns.length === 0 || bundleDiscountPaise <= 0) return null;
  const MIN_WORTH_SAYING = 1000; // ₹10 in paise, same bar as the ride hack
  if (bundleDiscountPaise < MIN_WORTH_SAYING) return null;

  const names = addOns.map((a) => a.name);
  const label = names.length === 1 ? names[0] : `${names.slice(0, -1).join(" + ")} + ${names[names.length - 1]}`;

  return {
    label: "Bundle hack",
    detail: `Add ${label} → Save ${rupees(bundleDiscountPaise)}`,
  };
}