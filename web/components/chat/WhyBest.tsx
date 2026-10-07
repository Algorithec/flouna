"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n/I18nContext";
import { Sparkles } from "lucide-react";
import { DisagreeSheet } from "./DisagreeSheet";
import { rupees } from "@/lib/money";
import type { FoodQuote } from "./types";

// "Why this is the best choice" — the reasoning panel from the Figma result
// screen.
//
// The design shows four fixed lines. Fixed copy would be a claim rather than a
// reason: it would say a pick was faster even when it was the slowest of the
// set. So each line is earned by comparing the winner against the options it
// actually beat, and a line that is not true is simply not shown.
export function WhyBest({
  best,
  alternatives,
}: {
  best: FoodQuote;
  alternatives: FoodQuote[];
}) {
  const { t } = useI18n();
  const [disagreeing, setDisagreeing] = useState(false);
  const reasons: string[] = [];

  if (alternatives.length > 0) {
    const slower = alternatives.filter((a) => a.etaMinutes > best.etaMinutes).length;
    if (slower > 0) {
      reasons.push(
        t("wb.sooner")
          .replace("{min}", String(best.etaMinutes))
          .replace("{n}", String(slower))
          .replace("{total}", String(alternatives.length)),
      );
    }

    const lowerRated = alternatives.filter((a) => a.rating < best.rating).length;
    if (lowerRated > 0) {
      reasons.push(
        t("wb.rated").replace("{rating}", String(best.rating)).replace("{n}", String(lowerRated)),
      );
    }

    const dearer = alternatives.filter((a) => a.effectivePaise > best.effectivePaise);
    if (dearer.length > 0) {
      const cheapestAlt = Math.min(...dearer.map((a) => a.effectivePaise));
      reasons.push(
        t("wb.cheaper").replace("{amount}", rupees(cheapestAlt - best.effectivePaise)),
      );
    }
  }

  const discount = best.offers.reduce((s, o) => s + o.discountPaise, 0);
  if (discount > 0) {
    reasons.push(
      t("wb.value").replace("{amount}", rupees(discount)),
    );
  }

  if (reasons.length === 0) {
    reasons.push(t("wb.balanced"));
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
        <Sparkles size={14} className="text-accent" />
        {t("wb.title")}
      </p>
      <ul className="flex flex-col gap-1.5">
        {reasons.map((r) => (
          <li key={r} className="flex items-start gap-2 text-[13px] leading-relaxed text-cocoa">
            <span className="mt-[6px] size-1.5 shrink-0 rounded-full bg-accent" />
            <span>{r}</span>
          </li>
        ))}
      </ul>

      {/* The other half of showing your reasoning is accepting that it can be
          wrong. AI policy 2.5 promises a way to say so and 2.6 promises a
          person will look if you ask, and neither was reachable from anywhere
          in the app. This is the entry point, next to the claim it disputes. */}
      <button
        type="button"
        onClick={() => setDisagreeing(true)}
        className="tap-target self-start text-[13px] font-medium text-accent underline underline-offset-2"
      >
        {t("wb.disagree")}
      </button>

      {disagreeing && <DisagreeSheet onClose={() => setDisagreeing(false)} />}
    </div>
  );
}
