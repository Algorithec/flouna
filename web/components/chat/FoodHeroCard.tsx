"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n/I18nContext";
import { Star, Heart, Share2, ShoppingCart, Minus, Plus, Check } from "lucide-react";
import { DishArt } from "@/components/food/DishArt";
import { useCart } from "@/lib/cart";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/format";
import type { FoodQuote } from "./types";

export function FoodHeroCard({ q, decisionId }: { q: FoodQuote; decisionId?: string }) {
  const { t } = useI18n();
  const { add } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [shared, setShared] = useState(false);

  const originalPaise = q.basePaise + q.deliveryFeePaise;
  const savingPaise = Math.max(0, originalPaise - q.effectivePaise);
  const discountPct = originalPaise > 0 ? Math.round((savingPaise / originalPaise) * 100) : 0;

  const onAdd = () => {
    add(
      {
        dishId: q.dishId,
        platform: q.platform,
        name: q.name,
        restaurant: q.restaurant,
        image: q.image,
        pricePaise: q.effectivePaise,
        decisionId,
      },
      qty,
    );
    setAdded(true);
    setTimeout(() => setAdded(false), 2000);
  };

  const onShare = async () => {
    const text = `${q.name} at ${q.restaurant} for ${rupees(q.effectivePaise)} on Flouna`;
    try {
      if (navigator.share) await navigator.share({ title: q.name, text });
      else {
        await navigator.clipboard.writeText(text);
        setShared(true);
        setTimeout(() => setShared(false), 2000);
      }
    } catch {
      /* the user dismissed the share sheet — nothing to report */
    }
  };

  const meta = q.portion && q.portion.length > 0 ? q.portion : q.tag ? [q.tag] : [];

  return (
    <div className="overflow-hidden rounded-[20px] border border-line bg-card p-2.5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="relative w-[40%] min-w-[120px] max-w-[156px] shrink-0 overflow-hidden rounded-[14px]">
          <div className="aspect-square w-full overflow-hidden rounded-[16px]">
            <DishArt name={q.name} image={q.image} fill className="size-full object-cover" />
          </div>

          {discountPct > 0 && (
            <span className="absolute left-0 top-0 max-w-[3.6rem] rounded-br-[14px] bg-[#b45309] px-2 py-1.5 text-center text-[11px] font-bold leading-[1.15] text-white">
              {t("fh.off").replace("{n}", String(discountPct))}
            </span>
          )}

          <button
            onClick={() => setSaved((v) => !v)}
            aria-label={saved ? t("fh.unsave") : t("fh.save")}
            className="absolute -right-1 top-2 z-10 flex size-8 items-center justify-center rounded-full bg-card shadow-sm"
          >
            <Heart
              size={15}
              className={cn(
                "transition-colors",
                saved ? "fill-accent text-accent" : "text-accent",
              )}
            />
          </button>
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[17px] font-bold leading-snug tracking-tight text-ink">{q.name}</p>
          <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-ink/85">
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <UtensilMark />
            </span>
            <span className="truncate font-medium">{q.restaurant}</span>
          </p>

          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-cocoa">
            <span className="flex items-center gap-0.5 font-semibold text-ink">
              <Star size={13} className="fill-[#f5a524] text-[#f5a524]" />
              {q.rating}
            </span>
            {q.ratingsCount != null && q.ratingsCount > 0 && (
              <>
                <span className="text-cocoa/35">|</span>
                <span>
                  {formatCount(q.ratingsCount)}+ {t("fh.ratings")}
                </span>
              </>
            )}
          </p>

          <div className="mt-2.5 border-t border-line/80 pt-2.5">
            <div className="flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-baseline gap-1.5">
                  <span className="text-[22px] font-extrabold tracking-tight text-ink">
                    {rupees(q.effectivePaise)}
                  </span>
                  {savingPaise > 0 && (
                    <span className="text-[13px] text-cocoa/50 line-through">
                      {rupees(originalPaise)}
                    </span>
                  )}
                </p>
                {savingPaise > 0 && (
                  <p className="mt-0.5 text-[12px] font-semibold text-accent">
                    {t("fh.youSave").replace("{amount}", rupees(savingPaise))}
                  </p>
                )}
              </div>

              <div className="flex h-[34px] shrink-0 items-center gap-2.5 rounded-[12px] border-[1.5px] border-accent px-2.5">
                <button
                  onClick={() => setQty((n) => Math.max(1, n - 1))}
                  disabled={qty === 1}
                  aria-label={t("fh.less")}
                  className="text-ink disabled:opacity-30"
                >
                  <Minus size={14} />
                </button>
                <span className="min-w-3.5 text-center text-[14px] font-bold text-ink">{qty}</span>
                <button
                  onClick={() => setQty((n) => Math.min(20, n + 1))}
                  aria-label={t("fh.more")}
                  className="text-ink"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>

          {meta.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 border-t border-line/80 pt-2 text-[11.5px] text-cocoa">
              <BoxMark />
              {meta.join("  |  ")}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2.5">
        <button
          onClick={onShare}
          className="flex flex-1 items-center justify-center gap-2 rounded-[16px] border border-line py-[11px] text-[14px] font-semibold text-ink transition-colors hover:bg-beige/40"
        >
          {shared ? <Check size={16} className="text-success" /> : <Share2 size={16} />}
          {shared ? t("grp.copied") : t("fh.share")}
        </button>
        <button
          onClick={onAdd}
          className="flex flex-[1.55] items-center justify-center gap-2 rounded-[16px] bg-accent py-[11px] text-[14px] font-semibold text-white transition-colors hover:bg-[#d4570f]"
        >
          {added ? <Check size={16} /> : <ShoppingCart size={16} />}
          {added ? t("fh.addedToCart") : t("fh.addToCart")}
        </button>
      </div>
    </div>
  );
}

function UtensilMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 1v4.5c0 .8.4 1.5 1 1.9V11H3.2V7.4A2.4 2.4 0 0 1 2 5.5V1h1Zm2 0v4.5c0 .8.4 1.5 1 1.9V11H5.2V7.4A2.4 2.4 0 0 1 4 5.5V1h1Zm4 0c.6 1.8.8 3.2.8 4.5 0 .9-.5 1.6-1.2 2V11H7.8V7.5c-.7-.4-1.2-1.1-1.2-2C6.6 4.2 6.8 2.8 7.4 1h.6c.4 1.6.6 2.9.6 4.2 0 .4.2.8.6.8s.6-.4.6-.8C9.8 3.9 10 2.6 10.4 1H10Z"
        fill="currentColor"
      />
    </svg>
  );
}

function BoxMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <path
        d="M1.5 3.8 6 1.5l4.5 2.3v4.4L6 10.5 1.5 8.2V3.8Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6 1.5v9M1.5 3.8 10.5 8.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
