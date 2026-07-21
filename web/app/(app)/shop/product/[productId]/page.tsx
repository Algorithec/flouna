"use client";

import { use, useEffect, useState } from "react";
import { Star, Truck, BadgePercent, ChevronLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { useI18n } from "@/components/i18n/I18nContext";
import { sellerName } from "@/lib/sellerName";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { LoadingView, ErrorView } from "@/components/ui/StatusView";
import { cn } from "@/lib/cn";
import type { ProductQuote } from "@/components/chat/types";

export default function ProductPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = use(params);
  const { t } = useI18n();
  const [quotes, setQuotes] = useState<ProductQuote[]>([]);
  const [platform, setPlatform] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Reset state when navigating to a different product (reset-during-render —
  // the codebase's pattern instead of a synchronous setState inside an effect).
  const [prevId, setPrevId] = useState(productId);
  if (prevId !== productId) {
    setPrevId(productId);
    setQuotes([]);
    setError("");
    setLoading(true);
  }

  useEffect(() => {
    let active = true;
    api<{ quotes: ProductQuote[] }>(`/api/shop/products/${productId}`)
      .then((d) => {
        if (!active) return;
        setQuotes(d.quotes);
        setPlatform(d.quotes[0]?.platform ?? "");
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [productId]);

  const selected = quotes.find((q) => q.platform === platform);

  if (loading) return <LoadingView rows={3} />;
  if (error)
    return (
      <ErrorView
        title="Couldn't load this product"
        message={error}
        backHref="/shop"
        backLabel="Back to Shop"
      />
    );
  if (!selected)
    return (
      <ErrorView
        notFound
        title="Product not found"
        message="This product may no longer be available."
        backHref="/shop"
        backLabel="Back to Shop"
      />
    );

  const discount = selected.offers.reduce((s, o) => s + o.discountPaise, 0);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 lg:px-6">
      <Link
        href="/shop"
        className="flex items-center gap-1 text-[13px] font-medium text-cocoa hover:text-ink"
      >
        <ChevronLeft size={16} /> Shop
      </Link>

      <h1 className="mt-3 text-[20px] font-bold text-ink">{selected.name}</h1>
      <p className="text-[13px] text-cocoa">{selected.brand}</p>
      <p className="mt-1 flex items-center gap-3 text-[12px] text-cocoa">
        <span className="flex items-center gap-0.5">
          <Star size={12} className="fill-accent text-accent" /> {selected.rating} (
          {selected.reviews.toLocaleString("en-IN")})
        </span>
      </p>

      <p className="mt-4 text-[12px] italic leading-relaxed text-cocoa">
        “{selected.reviewSummary}”
      </p>

      {/* Platform comparison */}
      <h2 className="mt-6 text-[14px] font-bold text-ink">{t("shop.compare")}</h2>
      <div className="mt-2 flex flex-col gap-2">
        {quotes.map((q) => (
          <button key={q.platform} onClick={() => setPlatform(q.platform)} className="text-left">
            <Card
              className={cn(
                "transition-colors",
                q.platform === platform && "border-accent/70 ring-1 ring-accent/30",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[14px] font-bold text-ink">{sellerName(q.platform)}</p>
                  <p className="flex items-center gap-1 text-[12px] text-cocoa">
                    <Truck size={12} /> {q.deliveryDays}{t("shop.dayDelivery")}
                  </p>
                  {q.offers[0] && (
                    <p className="flex items-center gap-1 text-[12px] text-success">
                      <BadgePercent size={12} /> {q.offers[0].label}
                    </p>
                  )}
                </div>
                <p className="text-[17px] font-bold text-ink">{rupees(q.effectivePaise)}</p>
              </div>
            </Card>
          </button>
        ))}
      </div>

      {/* Coupons */}
      <Card className="mt-4">
        <p className="text-[13px] font-bold text-ink">{t("shop.coupons")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {["WELCOME100", "HDFC10"].map((code) => (
            <span
              key={code}
              className="rounded-lg border border-dashed border-accent/50 bg-accent-soft/40 px-2.5 py-1 text-[12px] font-semibold text-accent"
            >
              {code}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-cocoa">
          Best applicable offer is already reflected in the price above.
        </p>
      </Card>

      {/* Bill */}
      <Card className="mt-4">
        <Row label={t("shop.listPrice")} value={rupees(selected.basePaise)} />
        {discount > 0 && <Row label={t("bill.offers")} value={`− ${rupees(discount)}`} accent />}
        <div className="my-2 h-px bg-line" />
        <Row label={t("shop.effectivePrice")} value={rupees(selected.effectivePaise)} bold />
      </Card>

      {/* Bought in-app — the order is routed to the seller via ONDC. */}
      <Button className="mt-5 w-full" onClick={() => {}}>
        {t("shop.buyNow")} · {rupees(selected.effectivePaise)}
      </Button>
      <p className="mt-3 flex items-center justify-center gap-1 text-center text-[11px] text-cocoa/70">
        <ShieldCheck size={12} /> Order &amp; pay in-app · best offer pre-applied
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: string;
  bold?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className={cn("text-[13px]", bold ? "font-bold text-ink" : "text-cocoa")}>
        {label}
      </span>
      <span
        className={cn(
          "text-[13px]",
          bold && "text-[15px] font-bold text-ink",
          accent && "font-medium text-success",
        )}
      >
        {value}
      </span>
    </div>
  );
}
