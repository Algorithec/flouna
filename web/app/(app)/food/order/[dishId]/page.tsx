"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Star, Clock, BadgePercent, ShieldCheck, MapPin, Bell, Check } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import dynamic from "next/dynamic";
import { useBudget } from "@/components/food/BudgetBar";
import { DishArt } from "@/components/food/DishArt";
import { useI18n } from "@/components/i18n/I18nContext";
import { useCart } from "@/lib/cart";
import { cn } from "@/lib/cn";
import type { FoodQuote } from "@/components/chat/types";

// Charts are client-only and heavy — load on demand.
const PriceHistoryChart = dynamic(
  () => import("@/components/food/PriceHistoryChart").then((m) => m.PriceHistoryChart),
  { ssr: false },
);

export default function FoodOrderPage({
  params,
}: {
  params: Promise<{ dishId: string }>;
}) {
  const { dishId } = use(params);
  const search = useSearchParams();
  const router = useRouter();
  const [quotes, setQuotes] = useState<FoodQuote[]>([]);
  const [platform, setPlatform] = useState(search.get("platform") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState<
    { label: string; line1: string; city: string } | null | undefined
  >(undefined);
  const budget = useBudget();
  const { t } = useI18n();
  const cart = useCart();
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertTarget, setAlertTarget] = useState("");
  const [alertDone, setAlertDone] = useState(false);
  const [alertBusy, setAlertBusy] = useState(false);

  async function createAlert() {
    const target = Number(alertTarget);
    if (!Number.isInteger(target) || target < 10) return;
    setAlertBusy(true);
    try {
      await api("/api/alerts", {
        method: "POST",
        json: { domain: "food", itemKey: dishId, targetRupees: target },
      });
      setAlertDone(true);
      setAlertOpen(false);
    } catch {
      // surfaced inline below if it fails
    } finally {
      setAlertBusy(false);
    }
  }

  useEffect(() => {
    api<{ addresses: Array<{ label: string; line1: string; city: string; isDefault: boolean }> }>(
      "/api/users/addresses",
    )
      .then((d) => setAddress(d.addresses.find((a) => a.isDefault) ?? d.addresses[0] ?? null))
      .catch(() => setAddress(null));
  }, []);

  useEffect(() => {
    api<{ quotes: FoodQuote[] }>(`/api/food/dishes/${dishId}`)
      .then((d) => {
        setQuotes(d.quotes);
        if (!d.quotes.some((q) => q.platform === platform)) {
          setPlatform(d.quotes[0]?.platform ?? "");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dishId]);

  const selected = quotes.find((q) => q.platform === platform);

  async function placeOrder() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const d = await api<{ order: { id: string } }>("/api/orders", {
        method: "POST",
        json: { domain: "food", dishId, platform: selected.platform },
      });
      router.push(`/pay/${d.order.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not place order");
      setBusy(false);
    }
  }

  if (!selected) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <p className="text-[14px] text-cocoa">{error || "Loading…"}</p>
      </div>
    );
  }

  const discount = selected.offers.reduce((s, o) => s + o.discountPaise, 0);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 lg:px-6">
      <div className="flex items-center gap-3.5">
        <DishArt name={selected.name} size={64} />
        <div className="min-w-0">
          <h1 className="text-[20px] font-bold text-ink">{selected.name}</h1>
          <p className="text-[13px] text-cocoa">{selected.restaurant}</p>
          <p className="mt-1 flex items-center gap-3 text-[12px] text-cocoa">
            <span className="flex items-center gap-0.5">
              <Star size={12} className="fill-accent text-accent" /> {selected.rating}
            </span>
            <span className="flex items-center gap-0.5">
              <Clock size={12} /> {selected.etaMinutes} min
            </span>
          </p>
        </div>
      </div>

      <p className="mt-4 text-[12px] italic leading-relaxed text-cocoa">
        “{selected.reviewSummary}”
      </p>

      {/* The engine's pick. Radiues compared this dish across sources and locked
          the best deal — users see one price and an anonymous comparison, never
          which networks were checked. */}
      <h2 className="mt-6 text-[14px] font-bold text-ink">{t("foodOrder.radiuesPrice")}</h2>
      <Card className="mt-2 border-accent/70 ring-1 ring-accent/30">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="inline-flex items-center rounded-pill bg-accent-soft px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-accent">
              {t("foodOrder.bestDeal")}
            </p>
            <p className="mt-1.5 text-[12px] text-cocoa">
              {t("foodOrder.delivery")} {rupees(selected.deliveryFeePaise)} · {selected.etaMinutes} min
            </p>
            {selected.offers[0] && (
              <p className="flex items-center gap-1 text-[12px] text-success">
                <BadgePercent size={12} /> {selected.offers[0].label}
              </p>
            )}
          </div>
          <p className="text-[22px] font-bold text-ink">
            {rupees(selected.effectivePaise)}
          </p>
        </div>
      </Card>
      {quotes.length > 1 &&
        (() => {
          const others = quotes.filter((q) => q.platform !== selected.platform);
          const cheapestOther = Math.min(...others.map((q) => q.effectivePaise));
          const saving = cheapestOther - selected.effectivePaise;
          return (
            <p className="mt-2 text-[12px] text-cocoa">
              {saving > 0 ? (
                <>
                  Compared with {others.length} other app{others.length > 1 ? "s" : ""} (
                  {others
                    .map((q) => rupees(q.effectivePaise))
                    .join(" · ")}
                  ) — <span className="font-semibold text-success">you save {rupees(saving)} here</span>.
                </>
              ) : (
                <>Compared with {others.length} other app{others.length > 1 ? "s" : ""} — picked for the best overall value.</>
              )}
            </p>
          );
        })()}

      {/* Delivery address */}
      <Card className="mt-4 py-3">
        <div className="flex items-center gap-2.5">
          <MapPin size={16} className="shrink-0 text-accent" />
          {address === undefined ? (
            <p className="text-[13px] text-cocoa">{t("foodOrder.loadingAddress")}</p>
          ) : address ? (
            <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
              <span className="font-semibold">{address.label}</span> —{" "}
              {address.line1}, {address.city}
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-[13px] text-cocoa">
              {t("foodOrder.noAddress")}
            </p>
          )}
          <Link
            href="/profile/addresses"
            className="shrink-0 text-[12px] font-semibold text-accent hover:underline"
          >
            {address ? t("foodOrder.change") : t("foodOrder.add")}
          </Link>
        </div>
      </Card>

      {/* Bill summary */}
      <Card className="mt-6">
        <Row label={t("bill.itemTotal")} value={rupees(selected.basePaise)} />
        <Row label={t("bill.deliveryFee")} value={rupees(selected.deliveryFeePaise)} />
        {discount > 0 && (
          <Row label={t("bill.offers")} value={`− ${rupees(discount)}`} accent />
        )}
        <div className="my-2 h-px bg-line" />
        <Row label={t("bill.totalAmount")} value={rupees(selected.effectivePaise)} bold />
      </Card>

      {/* Budget Guardian check */}
      {budget?.remainingPaise !== null &&
        budget?.remainingPaise !== undefined &&
        selected.effectivePaise > budget.remainingPaise && (
          <p className="mt-4 rounded-card border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-[12px] text-danger">
            Heads up — this order takes you{" "}
            {rupees(selected.effectivePaise - Math.max(0, budget.remainingPaise))}{" "}
            over your weekly food budget.
          </p>
        )}

      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}

      <Button onClick={placeOrder} disabled={busy} className="mt-5 w-full">
        {busy ? t("foodOrder.placing") : `${t("foodOrder.pay")} ${rupees(selected.effectivePaise)}`}
      </Button>
      <Button
        variant="secondary"
        onClick={() => {
          cart.add({
            dishId: selected.dishId,
            platform: selected.platform,
            name: selected.name,
            restaurant: selected.restaurant,
            pricePaise: selected.effectivePaise,
          });
          router.push("/cart");
        }}
        disabled={busy}
        className="mt-2.5 w-full"
      >
        Add to cart
      </Button>
      <p className="mt-3 flex items-center justify-center gap-1 text-[11px] text-cocoa/70">
        <ShieldCheck size={12} /> {t("foodOrder.inApp")}
      </p>

      {/* Price trend chart (shows only when we have ≥2 days of data) */}
      <PriceHistoryChart dishId={dishId} />

      {/* Price-drop alert */}
      <Card className="mt-5">
        {alertDone ? (
          <p className="flex items-center gap-2 text-[13px] font-medium text-success">
            <Check size={15} /> We&apos;ll notify you when {selected.name} drops to
            your target.
          </p>
        ) : alertOpen ? (
          <div>
            <p className="text-[13px] font-bold text-ink">
              Notify me when it drops below
            </p>
            <div className="mt-2 flex items-end gap-2">
              <Input
                label="Target price (₹)"
                inputMode="numeric"
                placeholder={String(Math.max(10, Math.round(selected.effectivePaise / 100) - 20))}
                value={alertTarget}
                onChange={(e) => setAlertTarget(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
              <Button
                size="md"
                onClick={createAlert}
                disabled={alertBusy || !alertTarget}
              >
                Set alert
              </Button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAlertOpen(true)}
            className="flex w-full items-center gap-2.5 text-left"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-beige/70">
              <Bell size={16} className="text-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-bold text-ink">
                {t("foodOrder.trackPrice")}
              </span>
              <span className="block text-[12px] text-cocoa">
                Get a live alert if {selected.name} gets cheaper
              </span>
            </span>
          </button>
        )}
      </Card>
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
