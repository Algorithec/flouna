"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n/I18nContext";
import { Sparkles } from "lucide-react";
import { rupees } from "@/lib/money";
import { DisagreeSheet } from "./DisagreeSheet";
import { SearchedPlatforms } from "./PlatformMark";
import type { FoodQuote, RideQuote, ProductQuote } from "./types";

// Shared reasoning surface from the Flouna result frames: the engine's
// summary, the earned "why this is the best choice" lines, and the platforms
// actually compared. Copy is never invented — a line that is not true of the
// returned data is simply not shown.

export function ReasoningCard({
  summary,
  reasons,
  platforms,
  onDisagree,
}: {
  summary?: string | null;
  reasons: string[];
  platforms?: string[];
  onDisagree?: () => void;
}) {
  const { t } = useI18n();
  if (!summary && reasons.length === 0 && !platforms?.length) return null;

  return (
    <div className="rounded-[18px] border border-line bg-card px-3.5 py-3.5 shadow-soft">
      {summary && (
        <>
          <p className="flex items-center gap-1.5 mb-2">
            <Sparkles size={13} className="text-accent shrink-0" />
          </p>
          <p className="text-[13px] leading-[1.55] text-ink/90">{summary}</p>
        </>
      )}

      {reasons.length > 0 && (
        <>
          <p className="mt-3 text-[13.5px] font-bold text-ink">{t("wb.title")}:</p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {reasons.map((r) => (
              <li
                key={r}
                className="flex items-start gap-2.5 text-[13px] leading-relaxed text-ink/80"
              >
                <span className="mt-[5px] size-[10px] shrink-0 rounded-full bg-accent" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {platforms && platforms.length > 0 && (
        <div className="mt-3">
          <SearchedPlatforms platforms={platforms} copy="checked-count" />
        </div>
      )}

      {onDisagree && (
        <button
          type="button"
          onClick={onDisagree}
          className="tap-target mt-2.5 self-start text-[12px] font-medium text-accent underline underline-offset-2"
        >
          {t("wb.disagree")}
        </button>
      )}
    </div>
  );
}

export function foodReasons(best: FoodQuote, alternatives: FoodQuote[], t: (k: "wb.sooner" | "wb.rated" | "wb.cheaper" | "wb.value" | "wb.balanced") => string): string[] {
  const reasons: string[] = [];
  const total = alternatives.length + 1;

  if (alternatives.length > 0) {
    const slower = alternatives.filter((a) => a.etaMinutes > best.etaMinutes).length;
    if (slower > 0) {
      reasons.push(
        (t("wb.sooner") as string)
          .replace("{min}", String(best.etaMinutes))
          .replace("{n}", String(slower))
          .replace("{total}", String(total)),
      );
    }

    const lowerRated = alternatives.filter((a) => a.rating < best.rating).length;
    if (lowerRated > 0) {
      reasons.push(
        (t("wb.rated") as string)
          .replace("{rating}", String(best.rating))
          .replace("{n}", String(lowerRated)),
      );
    }

    const dearer = alternatives.filter((a) => a.effectivePaise > best.effectivePaise);
    if (dearer.length > 0) {
      const cheapest = dearer.reduce((min, a) => Math.min(min, a.effectivePaise), Infinity);
      reasons.push(
        (t("wb.cheaper") as string).replace("{amount}", rupees(cheapest - best.effectivePaise)),
      );
    }
  }

  const discount = best.offers.reduce((s, o) => s + o.discountPaise, 0);
  if (discount > 0 && !reasons.some((r) => r.includes(rupees(discount)))) {
    reasons.push(
      (t("wb.value") as string).replace("{amount}", rupees(discount)),
    );
  }

  return reasons;
}

export function WhyBest({
  best,
  alternatives,
  why,
}: {
  best: FoodQuote;
  alternatives: FoodQuote[];
  why?: string | null;
}) {
  const { t } = useI18n();
  const [disagreeing, setDisagreeing] = useState(false);

  return (
    <>
      <ReasoningCard
        summary={why}
        reasons={foodReasons(best, alternatives, t)}
        platforms={[best.platform, ...alternatives.map((a) => a.platform)]}
        onDisagree={() => setDisagreeing(true)}
      />
      {disagreeing && <DisagreeSheet onClose={() => setDisagreeing(false)} />}
    </>
  );
}

export function RideWhyBest({
  why,
  quotes,
}: {
  why?: string | null;
  quotes: RideQuote[];
}) {
  const { t } = useI18n();
  const reasons: string[] = [];
  const best = quotes[0];

  if (best && quotes.length > 1) {
    const rest = quotes.slice(1);
    if (
      rest.every((q) => q.pickupEtaMinutes >= best.pickupEtaMinutes) &&
      rest.some((q) => q.pickupEtaMinutes > best.pickupEtaMinutes)
    ) {
      reasons.push(t("wb.ridePickup"));
    }
    if (
      rest.every((q) => q.effectivePaise >= best.effectivePaise) &&
      rest.some((q) => q.effectivePaise > best.effectivePaise)
    ) {
      reasons.push(t("wb.ridePrice"));
    }
    if (rest.some((q) => q.driverRating < best.driverRating)) {
      reasons.push(t("wb.rideQuality"));
    }
  }

  return (
    <ReasoningCard
      summary={why}
      reasons={reasons}
      platforms={quotes.map((q) => q.provider)}
    />
  );
}

export function ShopWhyBest({
  why,
  best,
  alternatives,
}: {
  why?: string | null;
  best: ProductQuote;
  alternatives: ProductQuote[];
}) {
  const { t } = useI18n();
  const reasons: string[] = [];

  if (alternatives.length > 0) {
    const dearer = alternatives.filter((a) => a.effectivePaise > best.effectivePaise);
    if (dearer.length > 0) reasons.push(t("wb.cheaper"));
  }

  return (
    <ReasoningCard
      summary={why}
      reasons={reasons}
      platforms={[best.platform, ...alternatives.map((a) => a.platform)]}
    />
  );
}
