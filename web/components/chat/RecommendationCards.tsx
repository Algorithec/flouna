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
  Info,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { AdviceBanner } from "@/components/ui/AdviceBanner";
import { FadeIn } from "@/components/ui/motion";
import { CategoryTile } from "@/components/ui/CategoryTile";
import { DishArt } from "@/components/food/DishArt";
import { useCart } from "@/lib/cart";
import { FoodHeroCard } from "./FoodHeroCard";
import { WhyBest } from "./WhyBest";
import { InlineRideBooking } from "./inline/InlineRideBooking";
import { SearchedPlatforms } from "./PlatformMark";
import { FlounaInsights, cheaperVehicleHack, bundleHack } from "./FlounaInsights";
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
  fastest: { label: "FASTEST", icon: Zap, className: "bg-success-soft text-success" },
  best_overall: { label: "BEST OVERALL", icon: Sparkles, className: "bg-accent-soft text-accent" },
};

function PickBadge({ reason }: { reason?: PickReason }) {
  if (!reason) return null;
  const b = PICK_BADGES[reason];
  const Icon = b.icon;
  return (
    <span
      className={cn(
        // self-start, or the flex column it sits in stretches it into a
        // full-width bar with the label marooned on the left. It reads as a
        // broken component rather than a badge.
        "inline-flex w-fit self-start items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide",
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
        <Zap size={12} /> FLOUNA INSIGHTS
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
  const insightProps = {
    quote: rec.best.reviewSummary,
    hacks: [
      bundleHack(rec.best.addOns ?? [], rec.best.bundleDiscountPaise ?? 0),
    ].filter((h): h is NonNullable<typeof h> => h !== null),
    offers: rec.best.offers,
  };

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

      {/* Nothing matched what was asked for. Saying so is the difference
          between a helpful stand-in and a confidently wrong answer — ask for
          sushi against this catalogue and a dosa arrives with no explanation. */}
      {rec.substituted && (
        <p className="flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>
            We don&apos;t have that on Flouna yet, here&apos;s the closest we
            can do right now.
          </span>
        </p>
      )}

      <WhyBest best={rec.best} alternatives={rec.alternatives} />

      {/* The places we actually looked, as evidence for the claim above it.
          "We compared these" is an assertion; the row of marks is the proof,
          and it is worth more to somebody deciding whether to trust the answer
          than another sentence saying the same thing. */}
      <SearchedPlatforms
        platforms={[rec.best.platform, ...rec.alternatives.map((a) => a.platform)]}
        copy="checked-count"
      />

      {/* Figma: section header with the count of options the engine compared */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[15px] font-bold text-ink">Available Providers</p>
        <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent">
          <Sparkles size={11} />
          {rec.alternatives.length + 1} option{rec.alternatives.length === 0 ? "" : "s"} found
        </span>
      </div>

      {/* insightProps extracted once so both the desktop rail and the mobile
          footer use the same values and cannot drift apart. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start lg:gap-4">
        <FoodHeroCard q={rec.best} decisionId={rec.decisionId} />

        {/* Desktop rail: InsightCard + FlounaInsights beside the hero.
            Hidden on mobile — insights render after alternatives below. */}
        <div className="hidden lg:flex lg:flex-col lg:gap-3">
          <InsightCard text={rec.why} />
          <FlounaInsights {...insightProps} />
        </div>
      </div>

      {rec.alternatives.length > 0 && (
        <>
          {/* Mobile: the design shows these openly rather than behind a
              toggle — the comparison is the product, so hiding it undersells
              the thing the engine just did. */}
          <div className="flex flex-col gap-2.5 lg:hidden">
            <p className="mt-1 text-[15px] font-bold text-ink">
              Options we think you&apos;ll like
            </p>
            {rec.alternatives.map((q) => (
              <FoodAltRow key={`${q.dishId}-${q.platform}`} q={q} />
            ))}
          </div>

          {/* Ordering together, offered where the alternatives are: the moment
              somebody is looking at four dishes is the moment splitting one
              bill occurs to them. */}
          <Link
            href="/food/group"
            className="tap-target mt-1 flex w-full items-center justify-center rounded-2xl border border-accent/50 bg-accent-soft/30 px-4 py-3 text-[14px] font-bold text-accent transition-colors hover:bg-accent-soft/60 lg:hidden"
          >
            Group ordering
          </Link>

          {/* Mobile: FlounaInsights after the group link — target reading order:
              hero → alternatives → group ordering → insights. Desktop already
              has it in the right rail above. */}
          <div className="lg:hidden">
            <FlounaInsights {...insightProps} />
          </div>

          {/* Desktop: "Options we think you'll like" card grid (Figma) */}
          <div className="hidden lg:block">
            <p className="mt-2 text-[15px] font-bold text-ink">
              Options we think you&apos;ll like
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3 xl:grid-cols-3">
              {rec.alternatives.map((q) => (
                <FoodAltCard
                  key={`${q.dishId}-${q.platform}`}
                  q={q}
                  decisionId={rec.decisionId}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </FadeIn>
  );
}


// Mobile alternative row — Figma "Options we think you'll like": thumbnail,
// the platform it came from, price against its pre-offer total, and a single
// tap to add it without leaving the conversation.
function FoodAltRow({ q }: { q: FoodQuote }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  const originalPaise = q.basePaise + q.deliveryFeePaise;

  return (
    <Card className="py-3">
      <div className="flex items-center gap-3">
        <DishArt name={q.name} image={q.image} size={44} />
        <div className="min-w-0 flex-1">
          <span className="inline-block rounded-full bg-beige px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cocoa">
            {q.platform}
          </span>
          <p className="mt-1 truncate text-[14px] font-semibold text-ink">{q.name}</p>
          <p className="flex items-baseline gap-1.5">
            <span className="text-[14px] font-bold text-ink">{rupees(q.effectivePaise)}</span>
            {originalPaise > q.effectivePaise && (
              <span className="text-[12px] text-cocoa/70 line-through">
                {rupees(originalPaise)}
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => {
            add(
              {
                dishId: q.dishId,
                platform: q.platform,
                name: q.name,
                restaurant: q.restaurant,
                image: q.image,
                pricePaise: q.effectivePaise,
              },
              1,
            );
            setAdded(true);
            setTimeout(() => setAdded(false), 2000);
          }}
          className="shrink-0 rounded-pill border border-accent px-3.5 py-1.5 text-[12px] font-semibold text-accent transition-colors hover:bg-accent-soft"
        >
          {added ? "Added" : "+ Add"}
        </button>
      </div>
    </Card>
  );
}

// Compact alternative card for the desktop grid.
function FoodAltCard({ q, decisionId }: { q: FoodQuote; decisionId?: string }) {
  return (
    <Link
      href={`/food/order/${q.dishId}?platform=${q.platform}${decisionId ? `&decision=${decisionId}` : ""}`}
      className="block"
    >
      <Card className="h-full py-3.5 transition-all hover:-translate-y-0.5 hover:shadow-card">
        <div className="flex items-center gap-3">
          <DishArt name={q.name} image={q.image} size={44} />
          <div className="min-w-0 flex-1">
            {/* Which platform this price is on.
                Without it, two alternatives for the same dish from the same
                restaurant render as identical rows at different prices, and
                the reason for the difference is the one thing the comparison
                exists to show. The mobile row has always carried it; the
                desktop card was dropping it. */}
            <span className="inline-block rounded-full bg-beige px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cocoa">
              {q.platform}
            </span>
            <p className="mt-1 truncate text-[13px] font-bold text-ink">{q.name}</p>
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
  onBook,
}: {
  rec: Extract<Recommendation, { type: "ride" }>;
  /**
   * Given when the surrounding surface can finish a booking itself.
   *
   * The chat passes it and gets the map, both endpoints and confirm in the
   * thread. Anywhere else, the quote rows keep linking to the rides screen,
   * which is the only difference between the two and the reason this is one
   * component rather than two.
   */
  onBook?: (orderId: string) => void;
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

      <SearchedPlatforms platforms={rec.quotes.map((q) => q.provider)} copy="checked-count" />

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
          {!onBook && vehicles.length > 1 && (
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

          {onBook ? (
            <InlineRideBooking
              drop={rec.drop}
              // Asking for a bike and being shown cab fares is the engine
              // ignoring the one thing that was specified. Unstated stays
              // "any", which prices every type as before.
              vehicle={rec.vehicle}
              scheduledAt={rec.scheduledAt}
              onBooked={onBook}
              showAny={rec.vehicle === "any" || !rec.vehicle}
              decisionId={rec.decisionId}
              // The limits the rider stated. Chat could not apply them to a
              // placeholder trip; this card prices the real one.
              fareLimitPaise={rec.fareLimitPaise}
              pickupLimitMinutes={rec.pickupLimitMinutes}
            />
          ) : (
            shown.map((q) => (
              <RideQuoteRow
                key={q.productName}
                q={q}
                drop={rec.drop}
                scheduledAt={rec.scheduledAt}
              />
            ))
          )}
        </div>

        <div className="flex flex-col gap-3">
          {/* Card form on desktop only: mobile already has this same text as a
              paragraph above, and printing it twice on the smaller screen is
              the one place there is no room for it. */}
          <div className="hidden lg:block">
            <InsightCard text={rec.why} />
          </div>
          {/* Worked out from the quotes, never written in. If no alternative
              is meaningfully cheaper, no tile appears rather than a made-up
              saving. */}
          {!onBook && (
            <FlounaInsights
              hacks={[
                cheaperVehicleHack(
                  { vehicle: shown[0]?.vehicle ?? "", effectivePaise: shown[0]?.effectivePaise ?? 0 },
                  rec.quotes,
                ),
              ].filter((h): h is NonNullable<typeof h> => h !== null)}
              offers={shown[0]?.offers ?? []}
            />
          )}
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
        <Sparkles size={14} className="text-accent" /> Your evening, sorted
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
      <SearchedPlatforms
        platforms={[rec.best.platform, ...rec.alternatives.map((a) => a.platform)]}
        copy="checked-count"
      />
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
