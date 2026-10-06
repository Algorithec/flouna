"use client";

import { useState } from "react";
import { Star, Heart, Share2, ShoppingCart, Minus, Plus, Store, Check } from "lucide-react";
import { DishArt } from "@/components/food/DishArt";
import { useCart } from "@/lib/cart";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/format";
import type { FoodQuote } from "./types";

// The winning pick, drawn as the Figma result card: a hero image with the
// discount called out, the price shown against what it would otherwise cost,
// and the two things a person does next — add it, or share it.
//
// Everything here comes from the quote. Where the design shows catalogue
// detail we do not hold (gram weight, rating counts), the card uses what we
// actually know rather than inventing numbers for a screenshot.

export function FoodHeroCard({ q, decisionId }: { q: FoodQuote; decisionId?: string }) {
  const { add } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [shared, setShared] = useState(false);

  // effectivePaise = base + delivery − offers, so the pre-offer total is the
  // honest "was" price and the difference is the real saving.
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

  return (
    <div className="overflow-hidden rounded-[18px] border border-line bg-card shadow-card">
      <div className="relative">
        <DishArt name={q.name} image={q.image} fill className="h-[168px] w-full" />

        {discountPct > 0 && (
          <span className="absolute left-0 top-3 rounded-r-full bg-accent px-3 py-1.5 text-[12px] font-bold text-white shadow-sm">
            {discountPct}% OFF
          </span>
        )}

        <button
          onClick={() => setSaved((v) => !v)}
          aria-label={saved ? "Remove from saved" : "Save this dish"}
          className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-full bg-card/95 shadow-sm transition-colors hover:bg-card"
        >
          <Heart
            size={17}
            className={cn("transition-colors", saved ? "fill-danger text-danger" : "text-cocoa")}
          />
        </button>
      </div>

      <div className="flex flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[17px] font-bold text-ink">{q.name}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-accent">
              <Store size={13} className="shrink-0" />
              <span className="truncate">{q.restaurant}</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[12px] font-semibold text-success">
            <Star size={12} className="fill-success" /> {q.rating}
            {/* Written as a comparison, not a truthiness check: a dish with
                zero ratings would otherwise render a bare "0" beside the
                stars, because React prints the number that `&&` returns. No
                catalogue entry has zero today; every new one will. */}
            {q.ratingsCount != null && q.ratingsCount > 0 && (
              <span className="text-[12px] text-cocoa">
                · {formatCount(q.ratingsCount)} ratings
              </span>
            )}
          </span>
          <span className="rounded-full bg-beige px-2 py-0.5 text-[11px] font-medium text-cocoa">
            {q.tag}
          </span>
          <span className="rounded-full bg-beige px-2 py-0.5 text-[11px] font-medium text-cocoa">
            {q.dietary === "veg" ? "Veg" : "Non-veg"}
          </span>
          {q.portion?.map((p) => (
            <span
              key={p}
              className="rounded-full bg-beige px-2 py-0.5 text-[11px] font-medium text-cocoa"
            >
              {p}
            </span>
          ))}
        </div>

        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="flex items-baseline gap-2">
              <span className="text-[22px] font-bold text-ink">{rupees(q.effectivePaise)}</span>
              {savingPaise > 0 && (
                <span className="text-[14px] text-cocoa/70 line-through">
                  {rupees(originalPaise)}
                </span>
              )}
            </p>
            {savingPaise > 0 && (
              <p className="text-[12px] font-semibold text-success">
                {rupees(savingPaise)} off with current offers
              </p>
            )}
          </div>

          <div className="flex items-center gap-3 rounded-full border border-line px-3 py-1.5">
            <button
              onClick={() => setQty((n) => Math.max(1, n - 1))}
              disabled={qty === 1}
              aria-label="Reduce quantity"
              className="text-cocoa disabled:opacity-30"
            >
              <Minus size={15} />
            </button>
            <span className="min-w-4 text-center text-[14px] font-bold text-ink">{qty}</span>
            <button
              onClick={() => setQty((n) => Math.min(20, n + 1))}
              aria-label="Increase quantity"
              className="text-accent"
            >
              <Plus size={15} />
            </button>
          </div>
        </div>

        <div className="mt-1 flex items-center gap-2.5">
          <button
            onClick={onShare}
            className="flex flex-1 items-center justify-center gap-2 rounded-pill border border-line py-2.5 text-[14px] font-semibold text-ink transition-colors hover:bg-beige/50"
          >
            {shared ? <Check size={16} className="text-success" /> : <Share2 size={16} />}
            {shared ? "Copied" : "Share"}
          </button>
          <button
            onClick={onAdd}
            className="flex flex-[1.4] items-center justify-center gap-2 rounded-pill bg-accent py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-[#d4570f]"
          >
            {added ? <Check size={16} /> : <ShoppingCart size={16} />}
            {added ? "Added to Cart" : "Add to Cart"}
          </button>
        </div>
      </div>
    </div>
  );
}
