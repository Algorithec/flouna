"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Search,
  Zap,
  MapPin,
  Star,
  Clock,
  ChevronRight,
  Users,
  Bell,
  ShoppingCart,
  Soup,
  Beef,
  Pizza,
  Salad,
  Grid2x2,
  Plus,
  Check,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { AdviceBanner, type Advice } from "@/components/ui/AdviceBanner";
import { BudgetBar, useBudget } from "@/components/food/BudgetBar";
import { DishArt } from "@/components/food/DishArt";
import { useCart } from "@/lib/cart";
import { FadeIn, ScrollReveal, Stagger, StaggerItem } from "@/components/ui/motion";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { useI18n } from "@/components/i18n/I18nContext";
import { cn } from "@/lib/cn";
import type { FoodQuote } from "@/components/chat/types";

// Fixed category set matching the Figma food landing. `value` is the search
// term sent to the backend ("" = All / unfiltered).
const FOOD_CATEGORIES: { label: string; value: string; icon: LucideIcon }[] = [
  { label: "All", value: "All", icon: Soup },
  { label: "Burger", value: "Burger", icon: Beef },
  { label: "Pizza", value: "Pizza", icon: Pizza },
  { label: "Healthy", value: "Healthy", icon: Salad },
  { label: "More", value: "More", icon: Grid2x2 },
];

type Feed = {
  categories: string[];
  picks: FoodQuote[];
  suggestions: {
    fastestDeliveryMinutes: number;
    nearestKm: number;
    topRatedCount: number;
  };
  advice?: Advice;
};

export default function FoodLandingPage() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoodQuote[] | null>(null);
  const [error, setError] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(true);
  const budget = useBudget();
  const { t } = useI18n();
  const { count: cartCount } = useCart();

  useEffect(() => {
    api<Feed>("/api/food/feed")
      .then(setFeed)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
    // Settings → Smart suggestions toggle; default to shown on any failure.
    api<{ smartSuggestions: boolean }>("/api/users/preferences")
      .then((p) => setShowSuggestions(p.smartSuggestions))
      .catch(() => {});
  }, []);

  const activeQuery = (category === "All" ? query : `${query} ${category}`).trim();

  useEffect(() => {
    if (!activeQuery) return;
    const t = setTimeout(() => {
      api<{ quotes: FoodQuote[] }>(
        `/api/food/search?q=${encodeURIComponent(activeQuery)}`,
      )
        .then((d) => setResults(d.quotes))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [activeQuery]);

  const showSearch = activeQuery !== "" && results !== null;
  const loading = !feed && !error;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4 lg:px-6 lg:py-8">
      {/* Top bar — search + bell + cart, matching Figma */}
      <FadeIn y={8}>
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-pill border border-line bg-card px-4 py-3 shadow-card">
            <Search size={18} className="text-cocoa/60" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("food.searchPlaceholder")}
              maxLength={120}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-cocoa/50"
            />
          </div>
          <button
            aria-label="Notifications"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-cocoa transition-colors hover:bg-beige/50"
          >
            <Bell size={20} />
          </button>
          <Link
            href="/cart"
            aria-label="Cart"
            className="relative flex size-10 shrink-0 items-center justify-center rounded-full text-cocoa transition-colors hover:bg-beige/50"
          >
            <ShoppingCart size={20} />
            {cartCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex size-4.5 min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                {cartCount > 9 ? "9+" : cartCount}
              </span>
            )}
          </Link>
        </div>
      </FadeIn>

      {/* Categories — fixed Figma set as 52×64 icon tiles */}
      <FadeIn delay={0.06} y={8}>
        <div className="no-scrollbar mt-4 flex justify-between gap-2 overflow-x-auto">
          {FOOD_CATEGORIES.map(({ label, value, icon: Icon }) => {
            const active = category === value;
            return (
              <button
                key={label}
                onClick={() => setCategory(value)}
                className="flex shrink-0 flex-col items-center gap-1.5"
              >
                <span
                  className={cn(
                    "flex size-[52px] items-center justify-center rounded-[16px] border transition-colors",
                    active
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line bg-card text-cocoa hover:bg-beige/40",
                  )}
                >
                  <Icon size={24} strokeWidth={2} />
                </span>
                <span
                  className={cn(
                    "text-[12px]",
                    active ? "font-semibold text-accent" : "text-cocoa",
                  )}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </FadeIn>

      {error && <p className="mt-6 text-[13px] text-danger">{error}</p>}

      {!showSearch && (
        <FadeIn delay={0.12} y={8}>
          <Link
            href="/food/group"
            className="mt-4 flex items-center gap-2.5 rounded-card border border-accent/40 bg-accent-soft/50 px-4 py-3 transition-colors hover:bg-accent-soft"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
              <Users size={18} className="text-accent" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-ink">{t("food.groupOrder")}</p>
              <p className="text-[12px] text-cocoa">{t("food.groupOrderSub")}</p>
            </div>
            <ChevronRight size={16} className="shrink-0 text-cocoa/50" />
          </Link>
        </FadeIn>
      )}

      {showSearch ? (
        <section className="mt-6">
          <h2 className="text-[17px] font-bold text-ink">Results</h2>
          <Stagger className="mt-3 flex flex-col gap-2.5 lg:grid lg:grid-cols-2">
            {results.length === 0 && (
              <p className="text-[13px] text-cocoa">No matches — try “biryani”, “pizza” or “dosa”.</p>
            )}
            {results.map((q) => (
              <StaggerItem key={`${q.dishId}-${q.platform}`}>
                <DishRow q={q} />
              </StaggerItem>
            ))}
          </Stagger>
        </section>
      ) : loading ? (
        <div className="mt-6 flex flex-col gap-2.5 lg:grid lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <>
          {budget && <BudgetBar budget={budget} />}
          {feed?.advice && <AdviceBanner advice={feed.advice} className="mt-5" />}

          {/* AI picks */}
          <section className="mt-6">
            <p className="flex items-center gap-1 text-[12px] font-semibold text-accent">
              AI Recommends ✦
            </p>
            <div className="mt-1 flex items-center justify-between">
              <h2 className="text-[17px] font-bold text-ink">{t("food.pickedForYou")}</h2>
              <Link
                href="/home"
                className="rounded-pill border border-accent px-3 py-1 text-[12px] font-semibold text-accent transition-colors hover:bg-accent-soft"
              >
                Ask Radiues
              </Link>
            </div>
            <Stagger className="mt-3 flex flex-col gap-2.5 lg:grid lg:grid-cols-2">
              {(feed?.picks ?? []).map((q) => (
                <StaggerItem key={q.dishId}>
                  <DishRow q={q} />
                </StaggerItem>
              ))}
            </Stagger>
          </section>

          {/* Smart suggestions (hidden when turned off in Settings) */}
          {showSuggestions && (
          <ScrollReveal className="mt-8">
            <h2 className="text-[17px] font-bold text-ink">{t("food.smartSuggestions")}</h2>
            <p className="text-[12px] text-cocoa">
              Recommendations based on speed, distance &amp; ratings
            </p>
            <div className="mt-2 flex flex-col divide-y divide-line">
              <SuggestionRow
                icon={Zap}
                iconBg="bg-accent-soft"
                iconClass="text-accent"
                title="Fastest Delivery"
                subtitle="Get your food in the least time possible"
                value={`From ${feed?.suggestions.fastestDeliveryMinutes ?? "–"} min`}
                onPick={() => setQuery("momos")}
              />
              <SuggestionRow
                icon={MapPin}
                iconBg="bg-[#e3f6ec]"
                iconClass="text-success"
                title="Nearest to You"
                subtitle="Top restaurants near your location"
                value={`Within ${feed?.suggestions.nearestKm ?? "–"} km`}
                onPick={() => setQuery("thali")}
              />
              <SuggestionRow
                icon={Star}
                iconBg="bg-[#efe7fb]"
                iconClass="text-[#8b5cf6]"
                title="Top Rated Near You"
                subtitle="Highly rated restaurants you'll love"
                value="4.0+ rated"
                onPick={() => setQuery("cake")}
              />
            </div>
          </ScrollReveal>
          )}
        </>
      )}
    </div>
  );
}

// Dish card — Figma layout: tag pill, name, clock · rating, price + Order now,
// with a dish-art tile standing in until real photography lands.
function DishRow({ q }: { q: FoodQuote }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  function addToCart() {
    add({
      dishId: q.dishId,
      platform: q.platform,
      name: q.name,
      restaurant: q.restaurant,
      pricePaise: q.effectivePaise,
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 1200);
  }
  return (
    <Card className="transition-all hover:-translate-y-0.5 hover:shadow-card">
      <div className="flex items-center gap-3">
        <DishArt name={q.name} size={48} />
        <div className="min-w-0 flex-1">
          <span className="inline-block rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
            {q.tag}
          </span>
          <p className="mt-1 truncate text-[15px] font-bold text-ink">{q.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-cocoa">
            <Clock size={11} /> {q.etaMinutes} min
            <span className="flex items-center gap-0.5">
              <Star size={11} className="fill-accent text-accent" /> {q.rating}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <p className="text-[16px] font-bold text-ink">{rupees(q.effectivePaise)}</p>
          <button
            onClick={addToCart}
            aria-label={`Add ${q.name} to cart`}
            className={cn(
              "flex size-8 items-center justify-center rounded-full border transition-colors",
              added
                ? "border-success bg-success/10 text-success"
                : "border-accent/60 text-accent hover:bg-accent-soft",
            )}
          >
            {added ? <Check size={15} /> : <Plus size={15} />}
          </button>
          <Link
            href={`/food/order/${q.dishId}?platform=${q.platform}`}
            className="rounded-pill bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#d4570f]"
          >
            Order now
          </Link>
        </div>
      </div>
    </Card>
  );
}

// Smart-suggestion row — Figma: 36px tinted circle icon, title, subtitle,
// value + chevron, divider between rows.
function SuggestionRow({
  icon: Icon,
  iconClass,
  iconBg,
  title,
  subtitle,
  value,
  onPick,
}: {
  icon: LucideIcon;
  iconClass: string;
  iconBg: string;
  title: string;
  subtitle: string;
  value: string;
  onPick: () => void;
}) {
  return (
    <button onClick={onPick} className="w-full text-left">
      <div className="flex items-center gap-3 py-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            iconBg,
          )}
        >
          <Icon size={18} className={iconClass} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-bold text-ink">{title}</p>
          <p className="truncate text-[12px] text-cocoa">{subtitle}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-cocoa">
          {value} <ChevronRight size={14} />
        </span>
      </div>
    </button>
  );
}
