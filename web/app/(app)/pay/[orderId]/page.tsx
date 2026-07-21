"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Smartphone,
  CreditCard,
  Wallet,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { FadeIn } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";

type Status = {
  orderStatus: string;
  amount: number;
  title: string;
  domain: "food" | "ride";
  provider?: string;
  details?: {
    basePaise?: number;
    deliveryFeePaise?: number;
    convenienceFeePaise?: number;
    farePaise?: number;
    offers?: { label: string; discountPaise: number }[];
  };
  payment: { status: string; method: string | null } | null;
};

type Stage = "select" | "processing" | "done";
type Method = "upi" | "cash" | "card";

declare global {
  interface Window {
    Cashfree?: (config: { mode: string }) => {
      checkout: (opts: { paymentSessionId: string; redirectTarget: string }) => void;
    };
  }
}

export default function PayPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = use(params);
  const router = useRouter();
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [stage, setStage] = useState<Stage>("select");
  const [method, setMethod] = useState<Method>("upi");
  const [showSummary, setShowSummary] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    // Verify-then-load: if the buyer is returning from the Cashfree checkout,
    // the server confirms the payment against Cashfree directly (webhook-
    // independent), so a paid order shows success immediately instead of
    // re-offering payment. Harmless no-op for unpaid/simulated orders.
    api<{ orderStatus: string }>("/api/payments/verify", {
      method: "POST",
      json: { orderId },
    })
      .catch(() => null)
      .then(() => api<Status>(`/api/payments/status/${orderId}`))
      .then((s) => {
        setStatus(s);
        if (s.orderStatus !== "pending_payment") setStage("done");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [orderId]);

  async function pay() {
    setError("");
    setStage("processing");
    try {
      const d = await api<{
        mode: "cashfree" | "simulated";
        paymentSessionId?: string;
        cfEnv?: string;
      }>("/api/payments/checkout", { method: "POST", json: { orderId } });

      if (d.mode === "cashfree" && d.paymentSessionId) {
        await loadCashfreeSdk();
        window.Cashfree?.({ mode: d.cfEnv === "production" ? "production" : "sandbox" }).checkout({
          paymentSessionId: d.paymentSessionId,
          redirectTarget: "_self",
        });
        return;
      }

      await new Promise((r) => setTimeout(r, 2400));
      await api("/api/payments/simulate", {
        method: "POST",
        json: { orderId, method: method === "cash" ? "upi" : method },
      });
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
      setStage("select");
    }
  }

  if (!status) {
    return (
      <div className="mx-auto max-w-md px-4 py-12">
        <p className="text-[14px] text-cocoa">{error || "Loading…"}</p>
      </div>
    );
  }

  const d = status.details ?? {};
  const discount = d.offers?.reduce((s, o) => s + o.discountPaise, 0) ?? 0;
  const isFood = status.domain === "food";
  const fareLabel = isFood ? t("bill.totalAmount") : t("bill.totalFare");

  return (
    <div className="mx-auto w-full max-w-md px-4 py-6 lg:py-10">
      {/* Total Fare header — Figma: label left, amount + chevron right */}
      <FadeIn y={8}>
        <Card className="flex items-center justify-between">
          <p className="text-[15px] font-bold text-ink">{fareLabel}</p>
          <button
            onClick={() => setShowSummary((v) => !v)}
            className="flex items-center gap-1 text-[18px] font-bold text-ink"
          >
            {rupees(status.amount)}
            <ChevronDown
              size={18}
              className={cn("text-cocoa transition-transform", !showSummary && "-rotate-90")}
            />
          </button>
        </Card>
      </FadeIn>

      {stage === "select" && (
        <>
          {/* Payment pending */}
          <p className="mt-5 text-[14px] font-bold text-accent">{t("pay.pending")}</p>
          <p className="mt-0.5 text-[12px] text-cocoa">
            {isFood ? t("pay.pendingFoodSub") : t("pay.pendingRideSub")}
          </p>

          {/* Order summary breakdown */}
          {showSummary && (
            <Card className="mt-3">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-bold text-ink">{t("pay.summary")}</p>
                <Link
                  href={`/orders/${orderId}?invoice=1`}
                  className="text-[12px] font-semibold text-accent hover:underline"
                >
                  {t("pay.viewDetails")}
                </Link>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-cocoa">{status.title}</p>
              <div className="mt-3 flex flex-col gap-1.5 text-[13px]">
                {isFood ? (
                  <>
                    {d.basePaise !== undefined && (
                      <Row label={t("bill.itemTotal")} value={rupees(d.basePaise)} />
                    )}
                    {d.deliveryFeePaise !== undefined && (
                      <Row label={t("bill.deliveryFee")} value={rupees(d.deliveryFeePaise)} />
                    )}
                    {d.convenienceFeePaise ? (
                      <Row label={t("bill.packagingFee")} value={rupees(d.convenienceFeePaise)} />
                    ) : null}
                  </>
                ) : (
                  <Row label={t("bill.baseFare")} value={rupees(d.farePaise ?? status.amount)} />
                )}
                {discount > 0 && (
                  <Row label={t("bill.discount")} value={`− ${rupees(discount)}`} accent />
                )}
                <div className="my-1 h-px bg-line" />
                <Row label={fareLabel} value={rupees(status.amount)} bold />
              </div>
            </Card>
          )}

          {/* Choose payment method */}
          <h2 className="mt-6 text-[14px] font-bold text-ink">{t("pay.chooseMethod")}</h2>
          <div className="mt-3 flex flex-col gap-2.5">
            <MethodRow
              active={method === "upi"}
              onClick={() => setMethod("upi")}
              icon={<Smartphone size={18} className="text-accent" />}
              title={t("pay.upi")}
              subtitle={t("pay.upiSub")}
            />
            <MethodRow
              active={method === "cash"}
              onClick={() => setMethod("cash")}
              icon={<Wallet size={18} className="text-success" />}
              title={t("pay.cash")}
              subtitle={isFood ? t("pay.cashFoodSub") : t("pay.cashRideSub")}
            />
            <MethodRow
              active={method === "card"}
              onClick={() => setMethod("card")}
              icon={<CreditCard size={18} className="text-[#8b5cf6]" />}
              title={t("pay.card")}
              subtitle={t("pay.cardSub")}
            />
          </div>

          {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
          <Button onClick={pay} className="mt-6 w-full">
            {t("pay.pay")} {rupees(status.amount)}
          </Button>
        </>
      )}

      {stage === "processing" && (
        <FadeIn className="mt-12 flex flex-col items-center text-center">
          <span className="flex items-center gap-2 text-[13px] font-semibold text-accent">
            <span className="size-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            {t("pay.processing")}
          </span>
          {/* UPI card animation */}
          <div className="relative mt-7 flex size-24 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-3xl bg-accent/10" />
            <div className="relative flex size-20 items-center justify-center rounded-3xl bg-accent-soft">
              <Smartphone size={34} className="text-accent" />
            </div>
          </div>
          <p className="mt-7 text-[14px] text-cocoa">{t("pay.processingSub")}</p>
          <p className="mt-4 flex items-center gap-1.5 text-[12px] text-cocoa/70">
            <CheckCircle2 size={13} className="text-success" /> {t("pay.dontClose")}
          </p>
        </FadeIn>
      )}

      {stage === "done" && (
        <FadeIn className="mt-10 flex flex-col items-center text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-success/10">
            <CheckCircle2 size={40} className="text-success" />
          </span>
          <p className="mt-4 text-[18px] font-bold text-ink">{t("pay.success")}</p>
          <p className="mt-1 text-[13px] text-cocoa">
            {isFood ? t("pay.successFood") : t("pay.successRide")}
          </p>
          <div className="mt-8 flex w-full flex-col gap-3">
            <Button onClick={() => router.push(`/orders/${orderId}`)} className="w-full">
              {isFood ? t("pay.trackOrder") : t("pay.trackRide")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => router.push(`/orders/${orderId}?invoice=1`)}
              className="w-full"
            >
              {t("pay.viewInvoice")}
            </Button>
          </div>
        </FadeIn>
      )}
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
    <div className="flex items-center justify-between">
      <span className={cn("text-cocoa", bold && "font-bold text-ink")}>{label}</span>
      <span
        className={cn(
          "text-ink",
          bold && "text-[15px] font-bold",
          accent && "font-medium text-success",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function MethodRow({
  active,
  onClick,
  icon,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button onClick={onClick} className="text-left">
      <Card
        className={cn(
          "py-3 transition-all",
          active ? "border-accent/70 ring-1 ring-accent/30" : "hover:shadow-card",
        )}
      >
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-beige/70">
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold text-ink">{title}</p>
            <p className="text-[12px] text-cocoa">{subtitle}</p>
          </div>
          {active ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-accent text-white">
              <CheckCircle2 size={14} />
            </span>
          ) : (
            <ChevronRight size={16} className="text-cocoa/40" />
          )}
        </div>
      </Card>
    </button>
  );
}

function loadCashfreeSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Cashfree) return resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.cashfree.com/js/v3/cashfree.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load payment SDK"));
    document.head.appendChild(s);
  });
}
