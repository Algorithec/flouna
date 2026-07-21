"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Star,
  Clock,
  Sparkles,
  Truck,
  Package,
  Wallet,
  Zap,
  Award,
  Tag,
  Utensils,
  Car,
  CircleCheck,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { AdviceBanner } from "@/components/ui/AdviceBanner";
import { FadeIn } from "@/components/ui/motion";
import { CategoryTile } from "@/components/ui/CategoryTile";
import { DishArt } from "@/components/food/DishArt";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import type {
  FoodQuote,
  ProductQuote,
  Recommendation,
  RideQuote,
  PickReason,
} from "./types";

// Why this option won — a small badge so the user sees the reasoning at a glance.
const PICK_BADGES: Record<
  PickReason,
  { label: string; icon: typeof Star; className: string }
> = {
  top_rated: { label: "TOP RATED", icon: Award, className: "bg-[#efe7fb] text-[#8b5cf6]" },
  best_price: { label: "BEST PRICE", icon: Tag, className: "bg-accent-soft text-accent" },
  fastest: { label: "FASTEST", icon: Zap, className: "bg-[#e3f6ec] text-success" },
  best_overall: { label: "BEST OVERALL", icon: Sparkles, className: "bg-accent-soft text-accent" },
};

function PickBadge({ reason }: { reason?: PickReason }) {
  if (!reason) return null;
  const b = PICK_BADGES[reason];
  const Icon = b.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide",
        b.className,
      )}
    >
      <Icon size={11} /> {b.label}
    </span>
  );
}

// "Tuned to your habits" — shown when the engine adapted the pick to the user's
// learned profile (spend band / favourites). Quietly omitted for new users.
function PersonalNote({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <p className="flex items-center gap-1.5 text-[12px] font-medium text-accent">
      <Sparkles size={13} className="shrink-0" />
      {note}
    </p>
  );
}

function FoodQuoteRow({ q, highlight }: { q: FoodQuote; highlight?: boolean }) {
  return (
    <Card
      className={
        highlight
          ? "border-accent/60 shadow-card ring-1 ring-accent/30"
          : "transition-all hover:-translate-y-0.5 hover:shadow-card"
      }
    >
      <div className="flex items-start gap-3">
        <DishArt name={q.name} size={46} />
        <div className="min-w-0 flex-1">
          <span className="inline-block rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
            {q.tag}
          </span>
          <p className="mt-1.5 truncate text-[15px] font-bold text-ink">{q.name}</p>
          <p className="truncate text-[12px] text-cocoa">{q.restaurant}</p>
          <p className="mt-1 flex items-center gap-2 text-[12px] text-cocoa">
            <span className="flex items-center gap-0.5">
              <Star size={12} className="fill-accent text-accent" /> {q.rating}
            </span>
            <span className="flex items-center gap-0.5">
              <Clock size={12} /> {q.etaMinutes} min
            </span>

          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[17px] font-bold text-ink">{rupees(q.effectivePaise)}</p>
          {q.offers.length > 0 && (
            <p className="text-[11px] text-success">{q.offers[0].label}</p>
          )}
          <Link
            href={`/food/order/${q.dishId}?platform=${q.platform}`}
            className="mt-2 inline-block rounded-pill bg-accent px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-[#d4570f] transition-colors"
          >
            Order now
          </Link>
        </div>
      </div>
    </Card>
  );
}

// Desktop-only section header + count pill (Figma "Results & Conversation").
function SectionHeader({
  icon: Icon,
  label,
  sub,
  count,
}: {
  icon: typeof Star;
  label: string;
  sub: string;
  count: number;
}) {
  return (
    <div className="hidden items-start justify-between gap-4 lg:flex">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-cocoa">
          <Icon size={13} /> {label}
        </p>
        <p className="mt-0.5 text-[13px] text-cocoa">{sub}</p>
      </div>
      <span className="flex shrink-0 items-center gap-1.5 rounded-pill border border-accent/40 bg-accent-soft px-3 py-1 text-[12px] font-semibold text-accent">
        <span className="size-1.5 rounded-full bg-accent" /> {count} Option
        {count === 1 ? "" : "s"} Found
      </span>
    </div>
  );
}

// Tinted insight rail card (Figma desktop right rail).
function InsightCard({ text }: { text: string }) {
  return (
    <div className="rounded-card border border-accent/30 bg-accent-soft/40 p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-accent">
        <Zap size={12} /> RADIUES INSIGHTS
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink">{text}</p>
    </div>
  );
}

// Minimal, ChatGPT/Claude-style result: the AI's answer as clean text, the one
// best pick, and other options tucked behind a toggle. On desktop the answer
// moves into an insights rail and the alternatives spread into a card grid.
export function FoodRecommendation({
  rec,
}: {
  rec: Extract<Recommendation, { type: "food" }>;
}) {
  const [showMore, setShowMore] = useState(false);
  return (
    <FadeIn y={8} className="flex w-full flex-col gap-2.5">
      <SectionHeader
        icon={Utensils}
        label="Food Order"
        sub="Best dining experience based on preparation quality, delivery time & consistency"
        count={1 + rec.alternatives.length}
      />

      <PickBadge reason={rec.pickReason} />
      <p className="text-[14px] leading-relaxed text-ink lg:hidden">{rec.why}</p>

      {rec.advice && <AdviceBanner advice={rec.advice} />}

      {rec.budgetNote && (
        <p
          className={cn(
            "flex items-center gap-1.5 text-[12px] font-medium",
            rec.budgetNote.startsWith("Heads up") ? "text-danger" : "text-success",
          )}
        >
          <Wallet size={13} className="shrink-0" />
          {rec.budgetNote}
        </p>
      )}

      <PersonalNote note={rec.personalNote} />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start lg:gap-4">
        <FoodQuoteRow q={rec.best} highlight />

        {/* Right rail — insights + offers (desktop only) */}
        <div className="hidden lg:flex lg:flex-col lg:gap-3">
          <InsightCard text={rec.why} />
          {rec.best.reviewSummary && (
            <div className="rounded-card border border-accent/30 bg-accent-soft/40 p-4">
              <p className="text-[13px] italic leading-relaxed text-ink">
                “{rec.best.reviewSummary}”
              </p>
            </div>
          )}
          {rec.best.offers.length > 0 && (
            <div className="rounded-card border border-success/30 bg-success/5 p-4">
              <p className="flex items-center gap-1.5 text-[12px] font-bold text-success">
                <Tag size={13} /> Available offers and coupons
              </p>
              <div className="mt-1.5 flex flex-col gap-1">
                {rec.best.offers.map((o) => (
                  <p key={o.label} className="flex items-center gap-1.5 text-[12px] text-ink">
                    <CircleCheck size={13} className="shrink-0 text-success" />
                    {o.label}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {rec.alternatives.length > 0 && (
        <>
          {/* Mobile: alternatives behind a toggle */}
          <div className="flex flex-col gap-2.5 lg:hidden">
            <button
              onClick={() => setShowMore((v) => !v)}
              className="self-start text-[12px] font-semibold text-accent hover:underline"
            >
              {showMore
                ? "Hide other options"
                : `See ${rec.alternatives.length} other option${rec.alternatives.length === 1 ? "" : "s"}`}
            </button>
            {showMore &&
              rec.alternatives.map((q) => (
                <FoodQuoteRow key={`${q.dishId}-${q.platform}`} q={q} />
              ))}
          </div>

          {/* Desktop: "Options we think you'll like" card grid (Figma) */}
          <div className="hidden lg:block">
            <p className="mt-2 text-[15px] font-bold text-ink">
              Options we think you&apos;ll like
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3 xl:grid-cols-3">
              {rec.alternatives.map((q) => (
                <FoodAltCard key={`${q.dishId}-${q.platform}`} q={q} />
              ))}
            </div>
          </div>
        </>
      )}
    </FadeIn>
  );
}

// Compact alternative card for the desktop grid.
function FoodAltCard({ q }: { q: FoodQuote }) {
  return (
    <Link href={`/food/order/${q.dishId}?platform=${q.platform}`} className="block">
      <Card className="h-full py-3.5 transition-all hover:-translate-y-0.5 hover:shadow-card">
        <div className="flex items-center gap-3">
          <DishArt name={q.name} size={44} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-bold text-ink">{q.name}</p>
            <p className="truncate text-[11px] text-cocoa">{q.restaurant}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-cocoa">
              <span className="flex items-center gap-0.5">
                <Star size={11} className="fill-accent text-accent" /> {q.rating}
              </span>
              {q.offers[0] && (
                <span className="rounded-full bg-success/10 px-1.5 py-px text-[10px] font-semibold text-success">
                  {q.offers[0].label}
                </span>
              )}
            </p>
          </div>
          <span className="shrink-0 rounded-pill bg-ink px-3 py-1.5 text-[12px] font-bold text-white">
            {rupees(q.effectivePaise)}
          </span>
        </div>
      </Card>
    </Link>
  );
}

function RideQuoteRow({
  q,
  drop,
  scheduledAt,
}: {
  q: RideQuote;
  drop?: string;
  scheduledAt?: string | null;
}) {
  // Carry the destination + chosen vehicle (and the scheduled time, if any)
  // so the rides screen opens ready — pickup comes from live GPS, drop is
  // geocoded, no re-asking.
  const href = drop
    ? `/rides?drop=${encodeURIComponent(drop)}&vehicle=${q.vehicle}${scheduledAt ? `&at=${encodeURIComponent(scheduledAt)}` : ""}`
    : "/rides";
  return (
    <Card
      className={
        q.badge === "BEST PRICE"
          ? "border-accent/60 shadow-card ring-1 ring-accent/30"
          : "transition-all hover:-translate-y-0.5 hover:shadow-card"
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[14px] font-bold text-ink">
            {q.displayName}
            {q.badge && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
                {q.badge}
              </span>
            )}
          </p>
          <p className="mt-0.5 flex items-center gap-2 text-[12px] text-cocoa">
            <span className="flex items-center gap-0.5">
              <Clock size={12} /> {q.pickupEtaMinutes} min away
            </span>
            <span className="flex items-center gap-0.5">
              <Star size={12} className="fill-accent text-accent" /> {q.driverRating}
            </span>
          </p>
          {q.offers[0] && (
            <p className="text-[11px] text-success">{q.offers[0].label}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[16px] font-bold text-ink">{rupees(q.effectivePaise)}</p>
          <Link
            href={href}
            className="mt-1.5 inline-block rounded-pill bg-accent px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-[#d4570f] transition-colors"
          >
            Select
          </Link>
        </div>
      </div>
    </Card>
  );
}

// Clean ride result: answer text + a Bike/Cab/Auto switcher so the user can
// change vehicle type, then the (cheapest-first) options for that type.
export function RideRecommendation({
  rec,
}: {
  rec: Extract<Recommendation, { type: "ride" }>;
}) {
  // Vehicle types present, in a stable display order.
  const order = ["bike", "auto", "cab"];
  const vehicles = order.filter((v) => rec.quotes.some((q) => q.vehicle === v));
  const [vehicle, setVehicle] = useState(vehicles[0] ?? "bike");

  // Quotes for the chosen vehicle, cheapest first.
  const shown = rec.quotes
    .filter((q) => q.vehicle === vehicle)
    .sort((a, b) => a.effectivePaise - b.effectivePaise);

  return (
    <FadeIn y={8} className="flex w-full flex-col gap-2.5">
      <SectionHeader
        icon={Car}
        label="Ride Booking"
        sub="Shortest pickup time with fair price & reliable availability"
        count={shown.length}
      />

      <p className="text-[14px] leading-relaxed text-ink lg:hidden">{rec.why}</p>

      {rec.advice && <AdviceBanner advice={rec.advice} />}

      {rec.scheduledAt && (
        <p className="flex items-center gap-1.5 self-start rounded-pill bg-accent-soft px-3 py-1 text-[12px] font-semibold text-accent">
          <Clock size={12} /> Scheduled for{" "}
          {new Date(rec.scheduledAt).toLocaleString("en-IN", {
            hour: "numeric",
            minute: "2-digit",
            day: "numeric",
            month: "short",
          })}
        </p>
      )}

      <div className="flex flex-col gap-2.5 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start lg:gap-4">
        <div className="flex min-w-0 flex-col gap-2.5">
          {/* Vehicle switcher — Figma desktop shows Bike / Cab / Auto tabs */}
          {vehicles.length > 1 && (
            <div className="flex rounded-pill bg-accent-soft/40 p-1">
              {vehicles.map((v) => (
                <button
                  key={v}
                  onClick={() => setVehicle(v)}
                  className={cn(
                    "flex-1 rounded-pill py-1.5 text-[13px] font-semibold capitalize transition-colors",
                    v === vehicle ? "bg-white text-accent shadow-soft" : "text-cocoa hover:text-ink",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          )}

          {shown.map((q) => (
            <RideQuoteRow
              key={q.productName}
              q={q}
              drop={rec.drop}
              scheduledAt={rec.scheduledAt}
            />
          ))}
        </div>

        {/* Insights rail (desktop only) */}
        <div className="hidden lg:block">
          <InsightCard text={rec.why} />
        </div>
      </div>
    </FadeIn>
  );
}

export function ComboRecommendation({
  rec,
}: {
  rec: Extract<Recommendation, { type: "combo" }>;
}) {
  return (
    <div className="flex w-full flex-col gap-4">
      <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
        <Sparkles size={14} className="text-accent" /> Your evening, sorted —
        food + ride in one go
      </p>
      {rec.food && (
        <div className="rounded-card border border-line/70 p-3">
          <FoodRecommendation rec={{ type: "food", ...rec.food }} />
        </div>
      )}
      <div className="rounded-card border border-line/70 p-3">
        <RideRecommendation rec={{ type: "ride", ...rec.ride }} />
      </div>
    </div>
  );
}

function ProductRow({ q, highlight }: { q: ProductQuote; highlight?: boolean }) {
  return (
    <Card
      className={
        highlight
          ? "border-accent/60 shadow-card ring-1 ring-accent/30"
          : "transition-all hover:-translate-y-0.5 hover:shadow-card"
      }
    >
      <div className="flex items-start gap-3">
        <span className="shrink-0">
          <CategoryTile icon={Package} theme="purple" size={46} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="inline-block rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
            {q.tag}
          </span>
          <p className="mt-1.5 truncate text-[15px] font-bold text-ink">{q.name}</p>
          <p className="truncate text-[12px] text-cocoa">{q.brand}</p>
          <p className="mt-1 flex items-center gap-2 text-[12px] text-cocoa">
            <span className="flex items-center gap-0.5">
              <Star size={12} className="fill-accent text-accent" /> {q.rating}
            </span>
            <span className="flex items-center gap-0.5">
              <Truck size={12} /> {q.deliveryDays}d
            </span>

          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[17px] font-bold text-ink">{rupees(q.effectivePaise)}</p>
          {q.offers.length > 0 && (
            <p className="text-[11px] text-success">{q.offers[0].label}</p>
          )}
          <Link
            href={`/shop/product/${q.productId}?platform=${q.platform}`}
            className="mt-2 inline-block rounded-pill bg-accent px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-[#d4570f] transition-colors"
          >
            View deal
          </Link>
        </div>
      </div>
    </Card>
  );
}

export function ShopRecommendation({
  rec,
}: {
  rec: Extract<Recommendation, { type: "shop" }>;
}) {
  return (
    <FadeIn y={8} className="flex w-full flex-col gap-2.5">
      <PickBadge reason={rec.pickReason} />
      <p className="text-[14px] leading-relaxed text-ink">{rec.why}</p>
      <PersonalNote note={rec.personalNote} />
      <ProductRow q={rec.best} highlight />
      <p className="-mt-1 text-[12px] italic text-cocoa/80">“{rec.best.reviewSummary}”</p>
      {rec.alternatives.length > 0 && (
        <>
          <p className="mt-1 text-[12px] font-semibold text-cocoa">
            Other places to buy
          </p>
          {rec.alternatives.map((q) => (
            <ProductRow key={`${q.productId}-${q.platform}`} q={q} />
          ))}
        </>
      )}
    </FadeIn>
  );
}
