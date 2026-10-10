"use client";

import { useEffect, useRef, useState } from "react";
import { Globe, ChevronDown, Check } from "lucide-react";
import { useI18n } from "./I18nContext";
import { LANGUAGES, type Lang } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/cn";

const LANG_METADATA: Record<Lang, { flag: string; native: string; subtitle: string; short: string }> = {
  en: { flag: "🇺🇸", native: "English", subtitle: "English", short: "EN" },
  hi: { flag: "🇮🇳", native: "हिन्दी", subtitle: "Hindi", short: "HI" },
  mr: { flag: "🇮🇳", native: "मराठी", subtitle: "Marathi", short: "MR" },
  kn: { flag: "🇮🇳", native: "ಕನ್ನಡ", subtitle: "Kannada", short: "KN" },
  ta: { flag: "🇮🇳", native: "தமிழ்", subtitle: "Tamil", short: "TA" },
  te: { flag: "🇮🇳", native: "తెలుగు", subtitle: "Telugu", short: "TE" },
};

export function LanguageSelector({ className }: { className?: string }) {
  const { t } = useI18n();
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentMeta = LANG_METADATA[lang] ?? LANG_METADATA.en;

  // Click outside to dismiss & Escape key handling
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function handleSelect(code: Lang) {
    setLang(code);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className={cn("relative inline-block text-left", className)}>
      {/* Floating Translucent Pill Button */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("ls.select")}
        title={t("ls.change")}
        className={cn(
          "group flex items-center gap-1.5 rounded-pill border border-line bg-card/85 px-3 py-1.5 text-[12px] font-semibold text-ink backdrop-blur-md transition-all duration-250 ease-out",
          "shadow-[0_2px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.02),inset_0_1px_1px_rgba(255,255,255,0.7)]",
          "hover:-translate-y-0.5 hover:border-accent/40 hover:bg-card hover:shadow-[0_6px_20px_rgba(0,0,0,0.08),inset_0_1px_1px_rgba(255,255,255,0.9)]",
          "active:scale-[0.97] active:translate-y-0",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          open && "border-accent/50 bg-accent-soft text-accent-ink shadow-[0_4px_16px_rgba(180,83,9,0.15)]",
        )}
      >
        <Globe
          size={14}
          className={cn(
            "text-cocoa transition-colors duration-200 group-hover:text-accent",
            open && "text-accent animate-pulse",
          )}
        />
        <span className="text-[13px]">{currentMeta.flag}</span>
        <span className="hidden sm:inline font-medium">{currentMeta.native}</span>
        <span className="sm:hidden font-medium">{currentMeta.short}</span>
        <ChevronDown
          size={13}
          className={cn(
            "text-cocoa/70 transition-transform duration-300 ease-out group-hover:text-accent",
            open && "rotate-180 text-accent",
          )}
        />
      </button>

      {/* Floating Glass Dropdown Panel */}
      <div
        role="listbox"
        aria-label={t("ls.languages")}
        className={cn(
          "absolute right-0 top-full mt-2.5 w-60 z-50 origin-top-right rounded-2xl border border-white/60 dark:border-white/10 bg-card/92 p-1.5 backdrop-blur-xl transition-all duration-250 ease-out",
          "shadow-[0_16px_40px_-6px_rgba(0,0,0,0.14),0_4px_16px_rgba(0,0,0,0.06),inset_0_1px_1px_rgba(255,255,255,0.8)]",
          open
            ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
            : "opacity-0 scale-95 -translate-y-1.5 pointer-events-none",
        )}
      >
        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-cocoa/60 border-b border-line/50 mb-1">
          {t("ls.selectTitle")}
        </div>

        <div className="flex flex-col gap-0.5">
          {LANGUAGES.map((l) => {
            const meta = LANG_METADATA[l.code] ?? {
              flag: "🌐",
              native: l.label,
              subtitle: l.label,
              short: l.code.toUpperCase(),
            };
            const isSelected = lang === l.code;

            return (
              <button
                key={l.code}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(l.code)}
                className={cn(
                  "group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-all duration-200",
                  isSelected
                    ? "bg-accent/10 font-semibold text-accent shadow-sm"
                    : "text-ink/85 hover:bg-beige/60 hover:text-ink hover:translate-x-0.5",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-[16px] leading-none transition-transform duration-200 group-hover:scale-110">
                    {meta.flag}
                  </span>
                  <div className="flex flex-col">
                    <span className="leading-tight font-semibold">{meta.native}</span>
                    {meta.native !== meta.subtitle && (
                      <span className="text-[11px] font-normal text-cocoa/60 leading-tight">
                        {meta.subtitle}
                      </span>
                    )}
                  </div>
                </div>

                {isSelected && (
                  <Check size={15} className="shrink-0 text-accent" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
