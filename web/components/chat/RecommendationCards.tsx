"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n/I18nContext";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  Info,
} from "lucide-react";
import { AdviceBanner } from "@/components/ui/AdviceBanner";
import { FadeIn } from "@/components/ui/motion";
import { CategoryTile } from "@/components/ui/CategoryTile";
import { DishArt } from "@/components/food/DishArt";
import { useCart } from "@/lib/cart";
import { FoodHeroCard } from "./FoodHeroCard";
import { WhyBest, RideWhyBest, ShopWhyBest } from "./WhyBest";
import { InlineRideBooking } from "./inline/InlineRideBooking";
import { PlatformChip } from "./PlatformMark";
import { FlounaInsights, cheaperVehicleHack, bundleHack } from "./FlounaInsights";
import { PlusUpsell } from "./PlusUpsell";
import {
  RideBestCard,
  RideOptionRow,
  VehicleTabs,
  ProvidersHeader,
} from "@/components/rides/RideOptionCard";
import { RideResultMap } from "@/components/rides/RideResultMap";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import type {
  FoodQuote,
  ProductQuote,
  Recommendation,
  RideQuote,
  PickReason,
} from "./types";

// The label is a key, not a word: these badges sit on the one surface the
// whole product is read through, and they were the last English left on a
// Telugu result card.
const PICK_BADGES: Record<
  PickReason,
  { labelKey: TranslationKey; icon: typeof Star; className: string }
> = {
  top_rated: { labelKey: "rc.badge.topRated", icon: Award, className: "bg-[#efe7fb] text-[#8b5cf6]" },
  best_price: { labelKey: "rc.badge.bestPrice", icon: Tag, className: "bg-accent-soft text-accent-ink" },
  fastest: { labelKey: "rc.badge.fastest", icon: Zap, className: "bg-success-soft text-success" },
  best_overall: { labelKey: "rc.badge.bestOverall", icon: Sparkles, className: "bg-accent-soft text-accent-ink" },
};

function PickBadge({ reason }: { reason?: PickReason }) {
  const { t } = useI18n();
  if (!reason) return null;
  const b = PICK_BADGES[reason];
  const Icon = b.icon;
  return (
    <span
      className={cn(
        "inline-flex w-fit self-start items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide",
        b.className,
      )}
    >
      <Icon size={11} /> {t(b.labelKey)}
    </span>
  );
}

function PersonalNote({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <p className="flex items-center gap-1.5 text-[12px] font-medium text-accent">
      <Sparkles size={13} className="shrink-0" />
      {note}
    </p>
  );
}

function ResultStack({ children }: { children: React.ReactNode }) {
  return (
    <FadeIn y={8} className="mx-auto flex w-full min-w-0 max-w-[560px] flex-col gap-3 overflow-x-hidden">
      {children}
    </FadeIn>
  );
}


function MoreOptions({
  hidden,
  onShow,
}: {
  hidden: number;
  onShow: () => void;
}) {
  const { t } = useI18n();
  if (hidden <= 0) return null;
  return (
    <button
      type="button"
      onClick={onShow}
      className="tap-target w-full rounded-full border border-accent/45 bg-accent-soft/20 px-4 py-2.5 text-[13px] font-semibold text-accent-ink transition-colors hover:bg-accent-soft/50"
    >
      {t("hm.viewFull")}
    </button>
  );
}

export function FoodRecommendation({
  rec,
  compact = false,
}: {
  rec: Extract<Recommendation, { type: "food" }>;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(!compact);
  // Filtered first, then cut. Cutting first and filtering after left the hidden
  // count including the best pick, which is never in the list: a card showing
  // everything it had still offered "view the full list", and the button only
  // set a flag that was already set.
  const allAlts = rec.alternatives.filter(
    (q) => !(q.dishId === rec.best.dishId && q.platform === rec.best.platform),
  );
  const alts = expanded ? allAlts : allAlts.slice(0, 3);
  const insightProps = {
    quote: rec.best.reviewSummary?.trim() || undefined,
    hacks: [
      bundleHack(rec.best.addOns ?? [], rec.best.bundleDiscountPaise ?? 0),
    ].filter((h): h is NonNullable<typeof h> => h !== null),
    offers: rec.best.offers ?? [],
  };

  return (
    <ResultStack>
      <PickBadge reason={rec.pickReason} />
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

      {rec.substituted && (
        <p className="flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>{t("rc.notOnFlouna")}</span>
        </p>
      )}

      {rec.overBudgetPaise && rec.overBudgetPaise > 0 && (
        <p className="flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning">
          <Wallet size={15} className="mt-0.5 shrink-0" />
          <span>
            {t("rc.overBudget").replace("{amount}", rupees(rec.overBudgetPaise))}
          </span>
        </p>
      )}

      <WhyBest best={rec.best} alternatives={rec.alternatives} why={rec.why} />

      <ProvidersHeader count={1 + allAlts.length} />

      <FoodHeroCard q={rec.best} decisionId={rec.decisionId} />

      {alts.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[15px] font-bold text-ink">{t("ib.youllLike")}</p>
          {alts.map((q) => (
            <FoodAltRow
              key={`${q.dishId}-${q.platform}`}
              q={q}
              decisionId={rec.decisionId}
            />
          ))}
        </div>
      )}

      <MoreOptions
        hidden={allAlts.length - alts.length}
        onShow={() => setExpanded(true)}
      />

      <Link
        href="/food/group"
        className="tap-target flex w-full items-center justify-center rounded-2xl border border-accent/45 bg-accent-soft/30 px-4 py-3 text-[14px] font-semibold text-accent-ink transition-colors hover:bg-accent-soft/50"
      >
        {t("rc.groupOrdering")}
      </Link>

      <FlounaInsights {...insightProps} />
      <PlusUpsell href="/food" />
    </ResultStack>
  );
}

// The ranking this row came from travels with the line into the cart. Without
// it the decision log records only the customers who took the top pick, and
// nothing at all about the ones who rejected it for the third option — which
// is the signal the whole feature exists to collect.
function FoodAltRow({ q, decisionId }: { q: FoodQuote; decisionId?: string }) {
  const { t } = useI18n();
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  const originalPaise = q.basePaise + q.deliveryFeePaise;

  return (
    <div className="flex items-center gap-2.5 rounded-[18px] border border-line bg-card px-2.5 py-2 shadow-soft">
      <DishArt name={q.name} image={q.image} size={48} className="rounded-[12px]" />
      <div className="min-w-0 flex-1">
        <PlatformChip id={q.platform} />
        <p className="mt-0.5 truncate text-[13px] font-semibold text-ink">{q.name}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <p className="text-right">
          <span className="block text-[17px] font-extrabold leading-none text-ink">
            {rupees(q.effectivePaise)}
          </span>
          {originalPaise > q.effectivePaise && (
            <span className="text-[12px] text-cocoa/50 line-through">
              {rupees(originalPaise)}
            </span>
          )}
        </p>
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
                decisionId,
              },
              1,
            );
            setAdded(true);
            setTimeout(() => setAdded(false), 2000);
          }}
          className="rounded-full border-[1.5px] border-accent px-3 py-1.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accent-soft"
        >
          {added ? t("rc.added") : t("rc.add")}
        </button>
      </div>
    </div>
  );
}

export function RideRecommendation({
  rec,
  onBook,
  compact = false,
  chatSessionId,
  cardKey,
}: {
  rec: Extract<Recommendation, { type: "ride" }>;
  onBook?: (orderId: string) => void;
  compact?: boolean;
  chatSessionId?: string | null;
  cardKey?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const order = ["bike", "cab", "auto"];
  const vehicles = order.filter((v) => rec.quotes.some((q) => q.vehicle === v));
  const asked =
    rec.vehicle && rec.vehicle !== "any" && vehicles.includes(rec.vehicle)
      ? rec.vehicle
      : (vehicles[0] ?? rec.vehicle ?? "bike");
  const [vehicle, setVehicle] = useState(asked);
  const [prevAsked, setPrevAsked] = useState(asked);
  if (prevAsked !== asked) {
    setPrevAsked(asked);
    setVehicle(asked);
  }
  const [expanded, setExpanded] = useState(!compact);

  const shown = rec.quotes
    .filter((q) => q.vehicle === vehicle)
    .sort((a, b) => a.effectivePaise - b.effectivePaise);
  const preview = expanded ? shown : shown.slice(0, 4);
  const best = preview[0];
  const alts = preview.slice(1).filter((q) => q.productName !== best?.productName);
  const mapProviders = [...new Set(shown.map((q) => q.provider))];

  const rideHref = (q: RideQuote) =>
    rec.drop
      ? `/rides?drop=${encodeURIComponent(rec.drop)}&vehicle=${q.vehicle}${rec.scheduledAt ? `&at=${encodeURIComponent(rec.scheduledAt)}` : ""}`
      : "/rides";

  return (
    <ResultStack>
      {/* Reasoned about the list on the screen, not rec.quotes: the card shows
          the chosen vehicle sorted by price, so the reasons have to move when
          the tab does. */}
      <RideWhyBest why={rec.why} best={best} quotes={shown} />

      {rec.advice && <AdviceBanner advice={rec.advice} />}

      {rec.scheduledAt && (
        <p className="flex items-center gap-1.5 self-start rounded-pill bg-accent-soft px-3 py-1 text-[12px] font-semibold text-accent-ink">
          <Clock size={12} /> {t("rc.scheduledFor")}{" "}
          {new Date(rec.scheduledAt).toLocaleString("en-IN", {
            hour: "numeric",
            minute: "2-digit",
            day: "numeric",
            month: "short",
          })}
        </p>
      )}

      {onBook ? (
        <InlineRideBooking
          drop={rec.drop}
          vehicle={rec.vehicle}
          scheduledAt={rec.scheduledAt}
          onBooked={onBook}
          showAny={rec.vehicle === "any" || !rec.vehicle}
          decisionId={rec.decisionId}
          fareLimitPaise={rec.fareLimitPaise}
          pickupLimitMinutes={rec.pickupLimitMinutes}
          chatSessionId={chatSessionId}
          cardKey={cardKey}
        />
      ) : (
        <>
          <ProvidersHeader count={shown.length || rec.quotes.length} />
          <VehicleTabs
            vehicles={vehicles}
            value={vehicle}
            onChange={setVehicle}
          />
          {(rec.pickup || rec.drop) && (
            <RideResultMap
              key={`${rec.pickup ?? ""}|${rec.drop ?? ""}`}
              pickup={rec.pickup}
              drop={rec.drop}
              providers={mapProviders}
            />
          )}
          {best && (
            <FlounaInsights
              // Tiles, as the ride frames draw them. Stated here rather than
              // inferred from the hacks, which flipped this screen to the food
              // layout whenever no cheaper vehicle happened to be available.
              tiles
              hacks={[
                cheaperVehicleHack(
                  {
                    vehicle: best.vehicle,
                    effectivePaise: best.effectivePaise,
                  },
                  rec.quotes,
                ),
              ].filter((h): h is NonNullable<typeof h> => h !== null)}
              offers={best.offers ?? []}
            />
          )}
          {best && (
            <RideBestCard
              q={best}
              onSelect={() => router.push(rideHref(best))}
            />
          )}
          {alts.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-[15px] font-bold text-ink">{t("ib.youllLike")}</p>
              {alts.map((q) => (
                <RideOptionRow
                  key={q.productName}
                  q={q}
                  onSelect={() => router.push(rideHref(q))}
                />
              ))}
            </div>
          )}
          <MoreOptions
            hidden={shown.length - preview.length}
            onShow={() => setExpanded(true)}
          />
          <PlusUpsell href="/rides" />
        </>
      )}
    </ResultStack>
  );
}

export function ComboRecommendation({
  rec,
  compact = false,
}: {
  rec: Extract<Recommendation, { type: "combo" }>;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex w-full flex-col gap-4">
      <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink">
        <Sparkles size={14} className="text-accent" /> {t("rc.comboSorted")}
      </p>
      {rec.food && (
        <FoodRecommendation rec={{ type: "food", ...rec.food }} compact={compact} />
      )}
      <RideRecommendation rec={{ type: "ride", ...rec.ride }} compact={compact} />
    </div>
  );
}

function ShopHeroCard({ q }: { q: ProductQuote }) {
  const { t } = useI18n();
  const saving = Math.max(0, q.basePaise - q.effectivePaise);
  const discountPct = q.basePaise > 0 ? Math.round((saving / q.basePaise) * 100) : 0;

  return (
    <div className="overflow-hidden rounded-[20px] border border-line bg-card p-3 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="relative w-[38%] min-w-[104px] max-w-[148px] shrink-0 overflow-hidden rounded-[16px]">
          <div className="flex aspect-square w-full items-center justify-center bg-accent-soft/40">
            <CategoryTile icon={Package} theme="purple" size={72} />
          </div>
          {discountPct > 0 && (
            <span className="absolute left-0 top-0 max-w-[4.6rem] rounded-br-[14px] bg-[#b45309] px-2 py-1.5 text-center text-[11px] font-bold leading-[1.15] text-white">
              {t("fh.off").replace("{n}", String(discountPct))}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <PlatformChip id={q.platform} />
          <p className="mt-1 text-[16px] font-bold leading-snug text-ink">{q.name}</p>
          <p className="truncate text-[12px] text-cocoa">{q.brand}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-cocoa">
            <span className="flex items-center gap-0.5 font-semibold text-ink">
              <Star size={13} className="fill-[#f5a524] text-[#f5a524]" /> {q.rating}
            </span>
            {q.reviews > 0 && (
              <>
                <span className="text-cocoa/35">|</span>
                <span>{q.reviews}+</span>
              </>
            )}
            <span className="flex items-center gap-0.5">
              <Truck size={12} /> {q.deliveryDays}d
            </span>
          </p>
          <p className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[22px] font-extrabold tracking-tight text-ink">
              {rupees(q.effectivePaise)}
            </span>
            {saving > 0 && (
              <span className="text-[13px] text-cocoa/50 line-through">{rupees(q.basePaise)}</span>
            )}
          </p>
          {saving > 0 && (
            <p className="text-[12px] font-semibold text-accent">
              {t("fh.youSave").replace("{amount}", rupees(saving))}
            </p>
          )}
        </div>
      </div>
      <Link
        href={`/shop/product/${q.productId}?platform=${q.platform}`}
        className="mt-3 flex w-full items-center justify-center rounded-[16px] bg-accent py-[11px] text-[14px] font-semibold text-white transition-colors hover:bg-[#d4570f]"
      >
        {t("rc.viewDeal")}
      </Link>
    </div>
  );
}

function ProductRow({ q }: { q: ProductQuote }) {
  const { t } = useI18n();
  const saving = Math.max(0, q.basePaise - q.effectivePaise);
  return (
    <div className="flex items-center gap-2.5 rounded-[18px] border border-line bg-card px-2.5 py-2 shadow-soft">
      <span className="shrink-0">
        <CategoryTile icon={Package} theme="purple" size={48} />
      </span>
      <div className="min-w-0 flex-1">
        <PlatformChip id={q.platform} />
        <p className="mt-0.5 truncate text-[13px] font-semibold text-ink">{q.name}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <p className="text-right">
          <span className="block text-[17px] font-extrabold leading-none text-ink">
            {rupees(q.effectivePaise)}
          </span>
          {saving > 0 && (
            <span className="text-[12px] text-cocoa/50 line-through">{rupees(q.basePaise)}</span>
          )}
        </p>
        <Link
          href={`/shop/product/${q.productId}?platform=${q.platform}`}
          className="rounded-full border-[1.5px] border-accent px-3 py-1.5 text-[13px] font-semibold text-accent"
        >
          {t("rc.viewDeal")}
        </Link>
      </div>
    </div>
  );
}

export function ShopRecommendation({
  rec,
  compact = false,
}: {
  rec: Extract<Recommendation, { type: "shop" }>;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(!compact);
  // Filtered before the cut; see FoodRecommendation above.
  const allAlts = rec.alternatives.filter(
    (q) => !(q.productId === rec.best.productId && q.platform === rec.best.platform),
  );
  const alts = expanded ? allAlts : allAlts.slice(0, 3);
  return (
    <ResultStack>
      <PickBadge reason={rec.pickReason} />
      <PersonalNote note={rec.personalNote} />
      <ShopWhyBest why={rec.why} best={rec.best} alternatives={rec.alternatives} />
      <ProvidersHeader count={1 + allAlts.length} />
      <ShopHeroCard q={rec.best} />
      {alts.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[15px] font-bold text-ink">{t("ib.youllLike")}</p>
          {alts.map((q) => (
            <ProductRow key={`${q.productId}-${q.platform}`} q={q} />
          ))}
        </div>
      )}
      <MoreOptions
        hidden={allAlts.length - alts.length}
        onShow={() => setExpanded(true)}
      />
      <FlounaInsights
        quote={rec.best.reviewSummary?.trim() || undefined}
        offers={rec.best.offers ?? []}
      />
      <PlusUpsell href="/shop" />
    </ResultStack>
  );
}
