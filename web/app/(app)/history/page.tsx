"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useBackTo } from "@/lib/navHistory";
import {
  ArrowLeft,
  LayoutGrid,
  Car,
  Utensils,
  ChevronRight,
  Calendar,
  CircleCheck,
  ReceiptText,
  Star,
  Clock,
  Headset,
  CircleX,
  TrendingUp,
} from "lucide-react";
import { api } from "@/lib/api";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { CancelOrderSheet } from "@/components/orders/CancelOrderSheet";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/cn";

// Figma "Booking History" (Component page): centred title header, Recent
// History heading, one segmented pill bar with icons, an Activity Snapshot
// grid on the All tab, and provider cards that carry chips (Cancel /
// Need Help? / status) instead of an amount column.

type OrderSummary = {
  id: string;
  domain: "food" | "ride" | "shop";
  status: string;
  provider: string;
  title: string;
  amount: number;
  savedPaise?: number;
  createdAt: string;
};

const TABS = [
  { key: "", labelKey: "history.all", icon: LayoutGrid },
  { key: "ride", labelKey: "nav.rides", icon: Car },
  { key: "food", labelKey: "nav.food", icon: Utensils },
] as const satisfies ReadonlyArray<{
  key: string;
  labelKey: TranslationKey;
  icon: typeof LayoutGrid;
}>;

// Brand disc colours for the providers the simulator emits. Real logo art
// arrives with the affiliate agreements; until then the disc carries the
// brand's own colour and wordmark.
const PROVIDER_DISC: Record<string, { bg: string; fg: string; text: string }> = {
  zomato: { bg: "#e23744", fg: "#ffffff", text: "zomato" },
  swiggy: { bg: "#fc8019", fg: "#ffffff", text: "Swiggy" },
  uber: { bg: "#000000", fg: "#ffffff", text: "Uber" },
  ola: { bg: "#1c1c1c", fg: "#cddc39", text: "OLA" },
  rapido: { bg: "#fbc821", fg: "#1c1c1c", text: "rapido" },
  ondc: { bg: "#e8651a", fg: "#ffffff", text: "ONDC" },
};

// The design's status chips: Ongoing (clock) and Complete (check), plus the
// two states the design doesn't show but the data has.
function statusChip(status: string, t: (k: TranslationKey) => string) {
  switch (status) {
    case "completed":
      return { label: t("history.complete"), icon: CircleCheck, cls: "text-acct-ink" };
    case "cancelled":
      return { label: t("status.cancelled"), icon: CircleX, cls: "text-danger" };
    case "pending_payment":
      return { label: t("status.pending_payment"), icon: Clock, cls: "text-warning" };
    default:
      return { label: t("history.ongoing"), icon: Clock, cls: "text-acct-ink" };
  }
}

// The orders money was actually spent on: not one waiting for payment, one
// cancelled, or an ONDC order paid and refunded because it was never placed.
// Spend and savings both count only these, so a saving is never shown on
// money that was not spent.
const paidFor = (o: { status: string }) => !["pending_payment", "cancelled", "failed"].includes(o.status);

// "₹5.4k" in the snapshot tiles — paise in, compact rupees out.
function compactRupees(paise: number) {
  const r = paise / 100;
  if (r >= 100000) return `₹${(r / 100000).toFixed(1)}L`;
  if (r >= 1000) return `₹${(r / 1000).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
}

export default function HistoryPage() {
  const goBack = useBackTo("/home");
  const { t, lang } = useI18n();
  const localeTag = lang === "hi" ? "hi-IN" : lang === "te" ? "te-IN" : "en-IN";
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("");
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState<OrderSummary | null>(null);

  const [prevTab, setPrevTab] = useState(tab);
  if (prevTab !== tab) {
    setPrevTab(tab);
    setOrders(null);
  }

  const load = useCallback(() => {
    api<{ orders: OrderSummary[] }>(`/api/orders${tab ? `?domain=${tab}` : ""}`)
      .then((d) => setOrders(d.orders))
      .catch(() => setError(t("history.loadError")));
  }, [tab, t]);
  useEffect(load, [load]);

  const cancellable = (o: OrderSummary) =>
    o.status === "confirmed" || o.status === "in_progress";

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-10 lg:px-6">
      <FadeIn y={8}>
        <div className="flex items-center py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-beige/60"
          >
            <ArrowLeft size={18} className="text-ink" />
          </button>
          <h1 className="flex-1 pr-9 text-center text-[17px] font-extrabold text-ink">
            {t("history.bookingTitle")}
          </h1>
        </div>
        <h2 className="text-[18px] font-extrabold text-ink">{t("history.recent")}</h2>
      </FadeIn>

      <div className="mt-4 flex gap-1 rounded-pill bg-card p-1 shadow-soft">
        {TABS.map((tabItem) => {
          const active = tab === tabItem.key;
          const Icon = tabItem.icon;
          return (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-pill py-3 text-[13px] font-semibold transition-colors",
                active
                  ? "bg-accent-soft text-accent-ink"
                  : "text-cocoa hover:bg-beige/40",
              )}
            >
              <Icon size={15} />
              {t(tabItem.labelKey)}
            </button>
          );
        })}
      </div>

      {error && <p className="mt-6 text-[13px] text-danger">{error}</p>}

      {/* Activity Snapshot — All tab only, per the design, and shown at zero
          on an empty account rather than hidden. */}
      {tab === "" && orders && (
        <>
          <h3 className="mt-5 flex items-center gap-1.5 text-[16px] font-extrabold text-ink">
            {t("history.snapshot")} <TrendingUp size={15} className="text-cocoa" />
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatTile
              icon={Calendar}
              value={String(orders.length)}
              label={t("history.totalBookings")}
            />
            <StatTile
              icon={CircleCheck}
              value={String(orders.filter((o) => o.status === "completed").length)}
              label={t("status.completed")}
            />
            <StatTile
              icon={ReceiptText}
              value={compactRupees(orders.filter(paidFor).reduce((s, o) => s + o.amount, 0))}
              label={t("history.totalSpend")}
            />
            <StatTile
              icon={Star}
              value={compactRupees(orders.filter(paidFor).reduce((s, o) => s + (o.savedPaise ?? 0), 0))}
              label={t("history.totalSavings")}
              plainLabel
            />
          </div>
        </>
      )}

      <Stagger className="mt-5 flex flex-col gap-3">
        {orders === null && !error &&
          Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)}
        {orders?.length === 0 && (
          <p className="mt-1 text-[18px] font-extrabold text-ink">
            {t(tab === "ride" ? "history.noBookings" : "history.noOrders")}
          </p>
        )}
        {orders?.map((o) => {
          const disc = PROVIDER_DISC[o.provider] ?? {
            bg: "#e8651a",
            fg: "#ffffff",
            text: o.provider.slice(0, 6),
          };
          const chip = statusChip(o.status, t);
          const ChipIcon = chip.icon;
          return (
            <StaggerItem key={o.id}>
              <div className="rounded-[18px] bg-card p-4 shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-card">
                <Link href={`/orders/${o.id}`} className="flex items-center gap-3">
                  <span
                    className="flex size-11 shrink-0 items-center justify-center rounded-full"
                    style={{ background: disc.bg }}
                  >
                    <span
                      className="text-[8px] font-extrabold tracking-tight"
                      style={{ color: disc.fg }}
                    >
                      {disc.text}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-bold text-ink">
                      {o.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-cocoa">
                      <Calendar size={12} />
                      {new Date(o.createdAt).toLocaleDateString(localeTag, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-cocoa/50" />
                </Link>
                <div className="mt-3 flex flex-wrap gap-2">
                  {cancellable(o) && (
                    <button
                      onClick={() => setCancelling(o)}
                      className="tap-target flex items-center gap-1.5 rounded-pill border border-line bg-card px-3.5 py-1.5 text-[12px] font-semibold text-acct-ink transition-colors hover:bg-danger-soft hover:text-danger"
                    >
                      <CircleX size={13} /> {t("history.cancel")}
                    </button>
                  )}
                  <Link
                    href={`/orders/${o.id}/help`}
                    className="tap-target flex items-center gap-1.5 rounded-pill border border-line bg-card px-3.5 py-1.5 text-[12px] font-semibold text-acct-ink transition-colors hover:bg-beige/40"
                  >
                    <Headset size={13} /> {t("history.needHelp")}
                  </Link>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 rounded-pill border border-line bg-card px-3.5 py-1.5 text-[12px] font-semibold",
                      chip.cls,
                    )}
                  >
                    <ChipIcon size={13} /> {chip.label}
                  </span>
                </div>
              </div>
            </StaggerItem>
          );
        })}
      </Stagger>

      {cancelling && (
        <CancelOrderSheet
          orderId={cancelling.id}
          domain={cancelling.domain}
          onClose={() => setCancelling(null)}
          onCancelled={() => {
            setCancelling(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// Snapshot tile — icon in a soft square, big value, tiny label.
function StatTile({
  icon: Icon,
  value,
  label,
  plainLabel,
}: {
  icon: typeof Calendar;
  value: string;
  label: string;
  plainLabel?: boolean;
}) {
  return (
    <div className="rounded-[16px] bg-card p-3.5 shadow-soft">
      <span className="flex size-9 items-center justify-center rounded-[10px] bg-accent-soft">
        <Icon size={16} className="text-accent" />
      </span>
      <p className="mt-2.5 text-[18px] font-extrabold text-ink">{value}</p>
      <p
        className={cn(
          "mt-0.5 text-[10px] font-semibold text-cocoa",
          !plainLabel && "uppercase tracking-wide",
        )}
      >
        {label}
      </p>
    </div>
  );
}
