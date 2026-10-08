"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useState } from "react";
import { Star } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

// Post-delivery rating. Stars feed the community average that the
// recommendation engine scores on, so this isn't decoration — a rated dish
// genuinely moves in future picks.
export function RateOrder({
  orderId,
  domain,
  existingStars,
}: {
  orderId: string;
  domain: string;
  existingStars?: number | null;
}) {
  const { t } = useI18n();
  const [stars, setStars] = useState(existingStars ?? 0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [saved, setSaved] = useState(Boolean(existingStars));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();

  async function submit(value: number) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/orders/${orderId}/rate`, {
        method: "POST",
        json: { stars: value, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      });
      setSaved(true);
      toast(t("ro.thanks"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ro.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const isFood = domain === "food";

  if (saved) {
    return (
      <Card className="mt-4 border-success/40 bg-success/5">
        <p className="flex items-center gap-2 text-[14px] font-bold text-ink">
          <Star size={15} className="fill-accent text-accent" />
          {t("ro.thanksTitle")}
        </p>
        <p className="mt-1 text-[12px] text-cocoa">
          {t("ro.helps").replace("{n}", String(stars))}
        </p>
      </Card>
    );
  }

  return (
    <Card className="mt-4">
      <p className="text-[14px] font-bold text-ink">
        {isFood ? t("ro.howFood") : t("ro.howTrip")}
      </p>
      <p className="mt-0.5 text-[12px] text-cocoa">
        {t("ro.improves")}
      </p>

      <div className="mt-3 flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            disabled={busy}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setStars(n)}
            className="p-0.5 transition-transform hover:scale-110 disabled:opacity-50"
          >
            <Star
              size={28}
              className={cn(
                "transition-colors",
                (hover || stars) >= n
                  ? "fill-accent text-accent"
                  : "text-cocoa/30",
              )}
            />
          </button>
        ))}
      </div>

      {stars > 0 && (
        <>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 300))}
            placeholder={t("ro.note")}
            className="mt-3 w-full rounded-card border border-line bg-card px-3 py-2.5 text-[13px] text-ink outline-none placeholder:text-cocoa/50 focus:border-accent"
          />
          <button
            onClick={() => submit(stars)}
            disabled={busy}
            className="mt-3 h-11 w-full rounded-pill bg-accent text-[14px] font-semibold text-white transition-colors hover:bg-[#d4570f] disabled:opacity-50"
          >
            {busy ? t("ro.saving") : t("pp.chat.submitRating")}
          </button>
        </>
      )}

      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
