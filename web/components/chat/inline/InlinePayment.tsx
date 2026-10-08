"use client";

import Link from "next/link";
import { CheckCircle2, Loader2, AlertTriangle, Banknote, Smartphone, CreditCard } from "lucide-react";
import { rupees } from "@/lib/money";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/cn";
import { useCheckout, type PayMethod } from "@/lib/payments/useCheckout";

// Paying, in the thread.
//
// Runs on the same checkout hook the payment screen runs on, so there is one
// path to taking money rather than two that drift. This is layout only.
//
// Cash is offered for food and withheld for rides, matching the payment
// screen: a driver settling cash is a different arrangement from a restaurant
// doing it, and only one of them is supported.

const METHODS: { id: PayMethod; label: TranslationKey; icon: typeof Smartphone }[] = [
  { id: "upi", label: "pay.upi", icon: Smartphone },
  { id: "card", label: "pay.card", icon: CreditCard },
  { id: "cash", label: "pay.cash", icon: Banknote },
];

export function InlinePayment({
  orderId,
  onPaid,
}: {
  orderId: string;
  /** Lets the thread say something once the money is taken. */
  onPaid?: () => void;
}) {
  // "_modal" so the gateway opens over the conversation instead of replacing
  // it. Paying is a step in the thread here, not a destination.
  const c = useCheckout(orderId, { redirectTarget: "_modal" });
  const { t } = useI18n();

  if (!c.status) {
    return (
      <div className="flex w-full items-center gap-2 rounded-card border border-line bg-card p-4 text-[13px] text-cocoa">
        <Loader2 size={15} className="animate-spin" /> {t("ipay.loading")}
      </div>
    );
  }

  const methods = METHODS.filter(
    (m) => m.id !== "cash" || c.status?.domain === "food",
  );

  if (c.stage === "done") {
    // A ride is not an order and a rider is not tracking a parcel. Using one
    // word for both is how "item damaged" ends up offered to somebody whose
    // complaint is about a driver.
    const isRide = c.status.domain === "ride";
    return (
      <div className="w-full rounded-card border border-success/30 bg-success/5 p-4">
        <p className="flex items-center gap-2 text-[14px] font-bold text-success">
          <CheckCircle2 size={17} />
          {c.paidWithCash
            ? isRide
              ? t("ipay.rideConfirmed")
              : t("pay.confirmedCash")
            : t("pay.success")}
        </p>
        <p className="mt-1 text-[13px] text-ink">
          {c.status.title} · {rupees(c.status.amount)}
          {c.paidWithCash ? t("ipay.cashOnDelivery") : ""}
        </p>
        <div className="mt-3 flex gap-2">
          <Link
            href={`/orders/${orderId}`}
            onClick={onPaid}
            className="tap-target rounded-pill bg-accent px-4 py-2.5 text-[13px] font-bold text-white"
          >
            {isRide ? t("pay.trackRide") : t("pay.trackOrder")}
          </Link>
          <Link
            href={`/orders/${orderId}/invoice`}
            className="tap-target rounded-pill border border-line px-4 py-2.5 text-[13px] font-semibold text-ink"
          >
            {t("ipay.receipt")}
          </Link>
        </div>
      </div>
    );
  }

  if (c.stage === "processing") {
    return (
      <div className="flex w-full items-center gap-2.5 rounded-card border border-line bg-card p-4">
        <Loader2 size={16} className="animate-spin text-accent" />
        <span className="text-[13px] text-ink">{t("ipay.processing")}</span>
      </div>
    );
  }

  return (
    <div className="w-full rounded-card border border-line bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-[14px] font-bold text-ink">
          {c.status.title}
        </p>
        <p className="shrink-0 text-[16px] font-bold text-ink">
          {rupees(c.status.amount)}
        </p>
      </div>

      {c.status.details?.drop && (
        <p className="mt-0.5 truncate text-[12px] text-cocoa">
          {t("ipay.to").replace("{place}", c.status.details.drop)}
        </p>
      )}

      {/* What was tried and when, rather than one red line. A person whose
          card was declined needs to know whether money left their account. */}
      {c.stage === "failed" && c.failed && (
        <div className="mt-3 rounded-xl border border-danger/30 bg-danger/5 p-3">
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-danger">
            <AlertTriangle size={14} />{" "}
            {t("ipay.failed").replace("{method}", c.failed.method.toUpperCase())}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-cocoa">
            {c.failed.message} {t("ipay.refundNote")}
          </p>
        </div>
      )}

      <div className="mt-3 flex gap-1.5">
        {methods.map((m) => {
          const Icon = m.icon;
          const on = c.method === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => c.setMethod(m.id)}
              className={cn(
                "tap-target flex flex-1 items-center justify-center gap-1.5 rounded-pill border px-2 py-2.5 text-[13px] font-semibold transition-colors",
                on
                  ? "border-accent bg-accent text-white"
                  : "border-line text-cocoa hover:bg-beige/50",
              )}
            >
              <Icon size={14} />
              {t(m.label)}
            </button>
          );
        })}
      </div>

      {c.error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {c.error}
        </p>
      )}

      <button
        type="button"
        onClick={() => c.pay()}
        className="tap-target mt-3 w-full rounded-pill bg-accent px-4 py-3 text-[14px] font-bold text-white"
      >
        {c.stage === "failed"
          ? t("ipay.tryAgain")
          : t("ipay.pay").replace("{amount}", rupees(c.status.amount))}
      </button>
    </div>
  );
}
