"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { useEffect, useState } from "react";

// What the engine is doing, while it does it.
//
// This replaced a checklist that revealed four steps and ticked them off. It
// looked like progress and was not: the steps were on a timer, so they ticked
// at the same pace whether the answer took half a second or eight, and a
// completed tick beside work that had not happened is a small lie told four
// times per question.
//
// One line instead, shimmering, naming the phase it is actually in. The phases
// still advance on a timer, but a phase that lingers reads as a phase that is
// taking a while, which is true, where a tick that lingers reads as broken.
//
// No spinner. The composer sits directly below this and a spinning element
// there pulls the eye down to the thing the person is waiting on rather than
// the answer forming above it.

/** Phases for a real comparison. Ordered as the work actually happens. */
const PHASES: TranslationKey[] = ["th.searching", "th.comparing", "th.applying", "th.picking"];

/** Roughly how long each phase holds before the next one takes over. */
const PHASE_MS = 1900;

export function ThinkingSteps({ simple = false }: { simple?: boolean }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (simple) return;
    const t = setInterval(() => {
      // Holds on the last phase rather than looping. Cycling back to
      // "Searching" after "Picking the best option" would say the work had
      // restarted, which is the one thing it must not imply.
      setPhase((p) => (p < PHASES.length - 1 ? p + 1 : p));
    }, PHASE_MS);
    return () => clearInterval(t);
  }, [simple]);

  // A greeting is not a price comparison. Claiming to compare providers for
  // "hello" is theatre, and the kind a person notices.
  const label = t(simple ? "th.thinking" : PHASES[phase]!);

  return (
    <div className="flex items-center pl-1">
      <span
        // Announced once rather than on every phase change: a screen reader
        // reading out four status updates for one answer is worse than
        // silence.
        role="status"
        aria-live="polite"
        aria-label={t("th.working")}
        className="text-shimmer text-[14px] font-medium"
      >
        {label}
        <ThinkingDots />
      </span>
    </div>
  );
}

/**
 * The trailing dots.
 *
 * Rendered at a fixed width so the line does not jitter left and right as they
 * cycle, which is what makes a loading state feel unsteady.
 */
function ThinkingDots() {
  const [n, setN] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v % 3) + 1), 420);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="inline-block w-[18px] text-left" aria-hidden>
      {".".repeat(n)}
    </span>
  );
}
