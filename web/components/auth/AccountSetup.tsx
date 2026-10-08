"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { FlounaLogo } from "@/components/brand/FlounaLogo";

const STEPS: TranslationKey[] = ["au.stepVerify", "au.settingUp", "au.stepPersonalize"];

const STEP_MS = 850;

// Full-screen branded transition shown after OTP verification succeeds.
export function AccountSetup({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (step < STEPS.length) {
      const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(onDone, 350);
    return () => clearTimeout(t);
  }, [step, onDone]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-cream px-8">
      <FlounaLogo size={110} className="animate-logo-glow text-ink" />

      <p className="mt-8 text-[18px] font-bold text-ink">
        {t("au.settingUp")}
      </p>

      <div className="mt-6 flex w-full max-w-[260px] flex-col gap-2.5">
        {STEPS.map((label, i) => (
          <div
            key={label}
            className="flex items-center gap-2 animate-fade-up"
            style={{ animationDelay: `${i * 120}ms` }}
          >
            {i < step ? (
              <CheckCircle2 size={16} className="shrink-0 text-success" />
            ) : i === step ? (
              <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-beige border-t-accent" />
            ) : (
              <span className="size-4 shrink-0 rounded-full border-2 border-line" />
            )}
            <span
              className={
                i <= step
                  ? "text-[13px] font-medium text-ink"
                  : "text-[13px] text-cocoa/50"
              }
            >
              {t(label)}
              {i === step && "…"}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-8 h-1.5 w-full max-w-[260px] overflow-hidden rounded-full bg-beige">
        <div className="animate-progress h-full rounded-full bg-accent" />
      </div>
    </div>
  );
}
