"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useState } from "react";
import { Share2, Check, Sparkles, Download, Loader2 } from "lucide-react";
import { rupees } from "@/lib/money";
import { renderReceiptImage } from "@/lib/receiptImage";

// Shareable proof-of-decision: what Flouna compared and what it saved.
// Shares a branded PNG when the device supports it, otherwise downloads the
// image or copies a text version — every share doubles as marketing.
export function DecisionReceipt({
  comparedOptions,
  comparedPlatforms,
  savedPaise,
  domain,
  title,
}: {
  comparedOptions: number;
  comparedPlatforms: number;
  savedPaise: number;
  domain: "food" | "ride";
  title: string;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "working" | "done">("idle");
  // Feature-detect once: native file-share vs. download fallback decides the icon.
  const [canNativeShare] = useState(
    () => typeof navigator !== "undefined" && typeof navigator.canShare === "function",
  );
  if (comparedOptions < 2) return null;

  const what = domain === "food" ? "my food order" : "my ride";
  const shareText =
    `Flouna compared ${comparedOptions} options across ${comparedPlatforms} apps for ${what}` +
    (savedPaise > 0 ? ` and saved me ${rupees(savedPaise)}` : " and picked the best one") +
    ". Stop searching, start deciding 🔶";

  async function share() {
    setState("working");
    try {
      const blob = await renderReceiptImage({
        comparedOptions,
        comparedPlatforms,
        savedPaise,
        domain,
        title,
      });

      const file = blob
        ? new File([blob], "flouna-savings.png", { type: "image/png" })
        : null;

      // 1. Native share with the image (mobile)
      if (
        file &&
        navigator.canShare?.({ files: [file] }) &&
        navigator.share
      ) {
        await navigator.share({ files: [file], text: shareText });
        setState("idle");
        return;
      }

      // 2. Download the image (desktop)
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "flouna-savings.png";
        a.click();
        URL.revokeObjectURL(url);
        setState("done");
        setTimeout(() => setState("idle"), 2500);
        return;
      }

      // 3. Last resort: copy text
      await navigator.clipboard.writeText(shareText);
      setState("done");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      // user cancelled the share sheet, or something failed — reset quietly
      setState("idle");
    }
  }

  return (
    <div className="rounded-card border border-accent/40 bg-gradient-to-br from-accent-soft/80 to-cream p-4">
      <p className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide text-accent">
        <Sparkles size={13} /> {t("dr.title")}
      </p>
      <p className="mt-2 text-[15px] font-bold leading-snug text-ink">
        {(() => {
          const line = t(savedPaise > 0 ? "dr.comparedSaved" : "dr.comparedPicked")
            .replace("{n}", String(comparedOptions))
            .replace("{apps}", String(comparedPlatforms));
          // The amount keeps its colour wherever the language puts it.
          const [before, after] = line.split("{amount}");
          return after === undefined ? (
            line
          ) : (
            <>
              {before}
              <span className="text-accent">{rupees(savedPaise)}</span>
              {after}
            </>
          );
        })()}
      </p>
      <button
        onClick={share}
        disabled={state === "working"}
        className="mt-3 flex items-center gap-1.5 rounded-pill bg-accent px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#d4570f] disabled:opacity-60"
      >
        {state === "working" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : state === "done" ? (
          <Check size={13} />
        ) : canNativeShare ? (
          <Share2 size={13} />
        ) : (
          <Download size={13} />
        )}
        {state === "working"
          ? t("dr.creating")
          : state === "done"
            ? t("dr.saved")
            : t("dr.share")}
      </button>
    </div>
  );
}
