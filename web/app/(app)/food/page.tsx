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
  BarChart3,
  Tag,
  Sparkles,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { VoiceButton } from "@/components/chat/VoiceButton";
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
  const [sort, setSort] = useState<"default" | "best" | "offers" | "new">("default");
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

  // Explore-more tiles re-order the picks list client-side.
  const picks = feed?.picks ?? [];
  const discount = (q: FoodQuote) =>
    (q.offers ?? []).reduce((s, o) => s + o.discountPaise, 0);
  const sortedPicks =
    sort === "best"
      ? [...picks].sort((a, b) => b.rating - a.rating)
      : sort === "offers"
        ? [...picks].sort((a, b) => discount(b) - discount(a))
        : sort === "new"
          ? [...picks].sort((a, b) => a.etaMinutes - b.etaMinutes)
          : picks;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4 lg:max-w-6xl lg:px-8 lg:py-6 lg:pb-32">
      {/* Desktop header — brand mark, bell + cart on the right (Figma desktop) */}
      <FadeIn y={8}>
        <div className="hidden items-center justify-between lg:flex">
          <span className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="" className="size-8 rounded-[8px]" />
            <span className="text-[22px] font-bold text-accent">Radiues</span>
          </span>
          <span className="flex items-center gap-2">
            <button
              aria-label="Notifications"
              className="flex size-10 items-center justify-center rounded-full text-cocoa transition-colors hover:bg-beige/50"
            >
              <Bell size={20} />
            </button>
            <Link
              href="/cart"
              aria-label="Cart"
              className="relative flex size-10 items-center justify-center rounded-full text-cocoa transition-colors hover:bg-beige/50"
            >
              <ShoppingCart size={20} />
              {cartCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex size-4.5 min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                  {cartCount > 9 ? "9+" : cartCount}
                </span>
              )}
            </Link>
          </span>
        </div>
      </FadeIn>

      {/* Mobile top bar — search + bell + cart, matching the mobile Figma */}
      <FadeIn y={8}>
        <div className="flex items-center gap-3 lg:hidden">
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

      {/* Categories — mobile: 52px icon tiles; desktop: wide chip buttons */}
      <FadeIn delay={0.06} y={8}>
        <div className="no-scrollbar mt-4 flex justify-between gap-2 overflow-x-auto lg:hidden">
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
        <div className="mt-5 hidden gap-3 lg:flex">
          {FOOD_CATEGORIES.map(({ label, value, icon: Icon }) => {
            const active = category === value;
            return (
              <button
                key={label}
                onClick={() => setCategory(value)}
                className={cn(
                  "flex h-[60px] flex-1 items-center justify-center gap-2.5 rounded-card border text-[14px] font-medium transition-colors",
                  active
                    ? "border-accent bg-card font-semibold text-accent"
                    : "border-transparent bg-beige/60 text-ink hover:bg-beige",
                )}
              >
                <Icon size={20} className={active ? "text-accent" : "text-ink"} />
                {label}
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
        <div className="lg:mt-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-5">
          <div className="min-w-0">
            {budget && <BudgetBar budget={budget} />}
            {feed?.advice && <AdviceBanner advice={feed.advice} className="mt-5" />}

            {/* AI picks — on desktop this sits inside a white panel (Figma) */}
            <section className="mt-6 lg:mt-0 lg:rounded-card lg:border lg:border-line lg:bg-card lg:p-5 lg:shadow-card">
              <p className="flex items-center gap-1 text-[12px] font-semibold text-accent">
                AI Recommends ✦
              </p>
              <div className="mt-1 flex items-center justify-between">
                <h2 className="text-[17px] font-bold text-ink lg:text-[19px]">
                  {t("food.pickedForYou")}
                </h2>
                <Link
                  href="/home"
                  className="rounded-pill border border-accent px-3 py-1 text-[12px] font-semibold text-accent transition-colors hover:bg-accent-soft"
                >
                  Ask Radiues
                </Link>
              </div>
              <Stagger className="mt-3 flex flex-col gap-2.5">
                {sortedPicks.map((q) => (
                  <StaggerItem key={q.dishId}>
                    <DishRow q={q} />
                  </StaggerItem>
                ))}
              </Stagger>
            </section>

            {/* Explore more — desktop-only shortcut tiles (Figma desktop) */}
            <section className="mt-5 hidden lg:block lg:rounded-card lg:border lg:border-line lg:bg-card lg:p-5 lg:shadow-card">
              <h2 className="text-[17px] font-bold text-ink">Explore more</h2>
              <p className="text-[12px] text-cocoa">More options to satisfy your cravings</p>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <ExploreTile
                  icon={BarChart3}
                  title="Best Sellers"
                  subtitle="Most ordered right now"
                  active={sort === "best"}
                  onClick={() => setSort(sort === "best" ? "default" : "best")}
                />
                <ExploreTile
                  icon={Tag}
                  title="Offers"
                  subtitle="Great deals & discounts"
                  active={sort === "offers"}
                  onClick={() => setSort(sort === "offers" ? "default" : "offers")}
                />
                <ExploreTile
                  icon={Sparkles}
                  title="New on Radiues"
                  subtitle="Fresh & fastest arrivals"
                  active={sort === "new"}
                  onClick={() => setSort(sort === "new" ? "default" : "new")}
                />
              </div>
            </section>
          </div>

          {/* Smart suggestions — right rail on desktop, section on mobile */}
          {showSuggestions && (
            <ScrollReveal className="mt-8 lg:mt-0 lg:rounded-card lg:border lg:border-line lg:bg-card lg:p-5 lg:shadow-card">
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
        </div>
      )}

      {/* Desktop bottom search — the big docked pill from the Figma desktop */}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-20 hidden lg:block">
        <div className="pointer-events-auto mx-auto flex w-full max-w-2xl items-center gap-3 rounded-[30px] border border-[#d0c8c0] bg-white py-2.5 pl-6 pr-2.5 shadow-[0px_6px_18px_rgba(0,0,0,0.10)]">
          <Search size={20} className="shrink-0 text-ink" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("food.searchPlaceholder")}
            maxLength={120}
            className="h-9 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-cocoa/50"
          />
          <VoiceButton onTranscript={setQuery} onFinal={setQuery} />
          <span className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-ink text-white">
            <ArrowRight size={17} />
          </span>
        </div>
      </div>
    </div>
  );
}

// Explore-more tile — Figma desktop: beige tile, icon, title + sub, chevron.
// Clicking toggles a re-ordering of the AI picks list.
function ExploreTile({
  icon: Icon,
  title,
  subtitle,
  active,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-card px-4 py-3.5 text-left transition-colors",
        active ? "bg-accent-soft" : "bg-beige/60 hover:bg-beige",
      )}
    >
      <Icon size={20} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold text-ink">{title}</span>
        <span className="block truncate text-[11px] text-cocoa">{subtitle}</span>
      </span>
      <ChevronRight size={15} className="shrink-0 text-cocoa/50" />
    </button>
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
