"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search, Star, Truck, Package } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { CategoryTile } from "@/components/ui/CategoryTile";
import { CardSkeleton } from "@/components/ui/Skeleton";
import type { ProductQuote } from "@/components/chat/types";
import { useI18n } from "@/components/i18n/I18nContext";

type Feed = { categories: string[]; picks: ProductQuote[] };

export default function ShopLandingPage() {
  const { t } = useI18n();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductQuote[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Feed>("/api/shop/feed")
      .then(setFeed)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  const activeQuery = (category === "All" ? query : `${query} ${category}`).trim();

  useEffect(() => {
    if (!activeQuery) return;
    const t = setTimeout(() => {
      api<{ quotes: ProductQuote[] }>(`/api/shop/search?q=${encodeURIComponent(activeQuery)}`)
        .then((d) => setResults(d.quotes))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [activeQuery]);

  const showSearch = activeQuery !== "" && results !== null;
  const loading = !feed && !error;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4 lg:px-6 lg:py-8">
      <FadeIn y={8}>
        <div className="flex items-center gap-2 rounded-pill border border-line bg-card px-4 py-3 shadow-card">
          <Search size={18} className="text-cocoa/60" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("shop.searchPh")}
            maxLength={120}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-cocoa/50"
          />
        </div>
      </FadeIn>

      <FadeIn delay={0.06} y={8}>
        <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto">
          {(feed?.categories ?? ["All"]).map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={
                c === category
                  ? "shrink-0 rounded-[14px] border border-accent bg-accent-soft px-4 py-2.5 text-[13px] font-semibold text-accent"
                  : "shrink-0 rounded-[14px] border border-line bg-card px-4 py-2.5 text-[13px] text-cocoa transition-colors hover:bg-beige/40"
              }
            >
              {c}
            </button>
          ))}
        </div>
      </FadeIn>

      {error && <p className="mt-6 text-[13px] text-danger">{error}</p>}

      {loading ? (
        <div className="mt-6 flex flex-col gap-2.5 lg:grid lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <section className="mt-6">
          <p className="flex items-center gap-1 text-[12px] font-semibold text-accent">
            AI Recommends ✦
          </p>
          <h2 className="mt-1 text-[17px] font-bold text-ink">
            {showSearch ? t("shop.results") : t("shop.trending")}
          </h2>
          <Stagger className="mt-3 flex flex-col gap-2.5 lg:grid lg:grid-cols-2">
            {showSearch && results.length === 0 && (
              <p className="text-[13px] text-cocoa">
                No matches — try “laptop”, “earbuds”, or “shoes”.
              </p>
            )}
            {(showSearch ? results : (feed?.picks ?? [])).map((q) => (
              <StaggerItem key={`${q.productId}-${q.platform}`}>
                <ProductCard q={q} />
              </StaggerItem>
            ))}
          </Stagger>
        </section>
      )}
    </div>
  );
}

function ProductCard({ q }: { q: ProductQuote }) {
  return (
    <Card className="transition-all hover:-translate-y-0.5 hover:shadow-card">
      <div className="flex items-center gap-3">
        <span className="shrink-0">
          <CategoryTile icon={Package} theme="purple" size={48} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="inline-block rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
            {q.tag}
          </span>
          <p className="mt-1 truncate text-[15px] font-bold text-ink">{q.name}</p>
          <p className="truncate text-[12px] text-cocoa">{q.brand}</p>
          <p className="flex items-center gap-2 text-[12px] text-cocoa">
            <span className="flex items-center gap-0.5">
              <Star size={12} className="fill-accent text-accent" /> {q.rating}
            </span>
            <span className="flex items-center gap-0.5">
              <Truck size={12} /> {q.deliveryDays}d
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <p className="text-[16px] font-bold text-ink">{rupees(q.effectivePaise)}</p>
          <Link
            href={`/shop/product/${q.productId}?platform=${q.platform}`}
            className="rounded-pill bg-accent px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#d4570f]"
          >
            View
          </Link>
        </div>
      </div>
    </Card>
  );
}
