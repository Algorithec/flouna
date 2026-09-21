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
  Gift,
  Clock,
  MapPin,
  X,
  AlertCircle,
  Info,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCheckout } from "@/lib/payments/useCheckout";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { FadeIn, SlideIn } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";


type AddressSummary = { label: string; line1: string; city: string; isDefault: boolean };


export default function PayPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = use(params);
  const router = useRouter();
  const { t } = useI18n();
  // The whole payment sequence, shared with the payment step inside the chat.
  // This screen keeps its layout and owns none of the machinery.
  const {
    status,
    stage,
    setStage,
    method,
    setMethod,
    failed,
    paidWithCash,
    error,
    pay,
    reset,
  } = useCheckout(orderId, { genericError: t("pay.failed.generic") });
  const [showSummary, setShowSummary] = useState(true);
  const [address, setAddress] = useState<AddressSummary | null>(null);
  // Off by default: reward credit is the buyer's to keep or spend, and quietly
  // draining it on an order they never asked to spend it on is not a saving.
  const [useWallet, setUseWallet] = useState(false);

  // Delivery address for the confirmation card (food orders).
  useEffect(() => {
    api<{ addresses: AddressSummary[] }>("/api/users/addresses")
      .then((d) => setAddress(d.addresses.find((a) => a.isDefault) ?? d.addresses[0] ?? null))
      .catch(() => setAddress(null));
  }, []);

  if (!status) {
    return (
      <div className="mx-auto max-w-md px-4 py-12">
        <p className="text-[14px] text-cocoa">{error || "Loading…"}</p>
      </div>
    );
  }

  const d = status.details ?? {};
  const discount = d.offers?.reduce((s, o) => s + o.discountPaise, 0) ?? 0;
  // Once credit is committed to an order it stays there until the order is
  // cancelled — the ledger allows one spend per order, so a toggle that
  // promised to undo it would be lying.
  const walletCommitted = status.walletAppliedPaise ?? 0;
  const walletBalance = status.walletBalancePaise ?? 0;
  const walletUse = walletCommitted > 0
    ? walletCommitted
    : useWallet
      ? Math.min(walletBalance, status.amount)
      : 0;
  const payable = Math.max(0, status.amount - walletUse);
  const canOfferWallet = walletCommitted > 0 || walletBalance > 0;
  const isFood = status.domain === "food";
  const fareLabel = isFood ? t("bill.totalAmount") : t("bill.totalFare");
  // True whether the order was just paid by cash or is being revisited later.
  const isCash = paidWithCash || status.payment?.method === "cash";

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
              {walletUse > 0 && (
                <>
                  <Row
                    label={t("pay.rewardsApplied")}
                    value={`− ${rupees(walletUse)}`}
                    accent
                  />
                  <Row label={t("pay.toPay")} value={rupees(payable)} bold />
                </>
              )}
            </div>
          </Card>
        )}

      {stage === "select" && (
        <>
          {/* Payment pending — Figma prefixes the heading with the same
              circled alert used on the failed screen below. */}
          <p className="mt-5 flex items-center gap-1.5 text-[14px] font-bold text-accent">
            <AlertCircle size={16} /> {t("pay.pending")}
          </p>
          <p className="mt-0.5 text-[12px] text-cocoa">
            {isFood ? t("pay.pendingFoodSub") : t("pay.pendingRideSub")}
          </p>

          {/* Rewards wallet. Sits above the method picker because it changes
              what the methods below are being asked for. */}
          {canOfferWallet && (
            <Card className="mt-5 py-3">
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                  <Gift size={17} className="text-accent" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-ink">
                    {t("pay.useRewards")}
                  </span>
                  <span className="block text-[12px] text-cocoa">
                    {walletCommitted > 0
                      ? t("pay.rewardsLocked")
                      : t("pay.rewardsAvailable").replace("{amount}", rupees(walletBalance))}
                  </span>
                </span>
                <button
                  role="switch"
                  aria-checked={walletUse > 0}
                  aria-label={t("pay.useRewards")}
                  disabled={walletCommitted > 0}
                  onClick={() => setUseWallet((v) => !v)}
                  className={cn(
                    "tap-target relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors",
                    walletUse > 0 ? "bg-accent" : "bg-switch-off",
                    walletCommitted > 0 && "opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-[3px] size-5 rounded-full bg-white shadow transition-all",
                      walletUse > 0 ? "left-[23px]" : "left-[3px]",
                    )}
                  />
                </button>
              </div>
            </Card>
          )}

          {/* Fully covered by rewards: there is no gateway step left, so
              offering a payment method would be a choice with no meaning. */}
          {payable === 0 ? (
            <p className="mt-5 rounded-card bg-success/10 px-4 py-3 text-[13px] text-success">
              {t("pay.rewardsCoverAll")}
            </p>
          ) : (
          <>
          {/* Choose payment method — squared tiles tinted per method (Figma),
              not the generic circular badge every other icon row uses. */}
          <h2 className="mt-6 text-[14px] font-bold text-ink">{t("pay.chooseMethod")}</h2>
          <div className="mt-3 flex flex-col gap-2.5">
            <MethodRow
              active={method === "upi"}
              onClick={() => setMethod("upi")}
              icon={<Smartphone size={18} className="text-[#3b6fe0]" />}
              tint="bg-[#3b6fe0]/10"
              title={t("pay.upi")}
              subtitle={t("pay.upiSub")}
            />
            <MethodRow
              active={method === "cash"}
              onClick={() => setMethod("cash")}
              icon={<Wallet size={18} className="text-success" />}
              tint="bg-success/10"
              title={t("pay.cash")}
              subtitle={isFood ? t("pay.cashFoodSub") : t("pay.cashRideSub")}
            />
            <MethodRow
              active={method === "card"}
              onClick={() => setMethod("card")}
              icon={<CreditCard size={18} className="text-[#8b5cf6]" />}
              tint="bg-[#8b5cf6]/10"
              title={t("pay.card")}
              subtitle={t("pay.cardSub")}
            />
          </div>
          </>
          )}

          {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
          <Button onClick={() => pay({ useWallet })} className="mt-6 w-full">
            {payable === 0
              ? t("pay.payWithRewards")
              : `${t("pay.pay")} ${rupees(payable)}`}
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
          {/* Never trap the buyer on this screen — if the gateway didn't take
              over, this returns them to the method picker. */}
          <button
            onClick={() => setStage("select")}
            className="mt-6 text-[12px] font-semibold text-cocoa underline hover:text-ink"
          >
            Taking too long? Go back to payment options
          </button>
        </FadeIn>
      )}

      {stage === "failed" && failed && (
        <SlideIn direction="top" className="mt-8 flex flex-col items-center text-center">
          {/* Figma "payment failed" (2453:2102) */}
          <span className="relative flex size-20 items-center justify-center">
            <span className="absolute inset-0 rounded-full bg-danger/10" />
            <span className="absolute inset-2 rounded-full bg-danger/15" />
            <span className="relative flex size-12 items-center justify-center rounded-full bg-danger">
              <X size={26} strokeWidth={3} className="text-white" />
            </span>
          </span>

          <h2 className="mt-5 flex items-center gap-2 text-[19px] font-bold text-danger">
            <AlertCircle size={19} />
            {t("pay.failed.title")}
          </h2>
          <p className="mt-1.5 text-[14px] text-cocoa">{t("pay.failed.sub")}</p>

          {/* What was actually attempted — named, not guessed at. */}
          <div className="mt-6 flex w-full items-center gap-3 rounded-2xl bg-danger-soft p-4 text-left">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger/10">
              {failed.method === "card" ? (
                <CreditCard size={18} className="text-danger" />
              ) : failed.method === "cash" ? (
                <Wallet size={18} className="text-danger" />
              ) : (
                <Smartphone size={18} className="text-danger" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">
                {t(`pay.${failed.method}`)}
              </span>
              <span className="block text-[12px] text-cocoa">
                {t("pay.failed.at")}{" "}
                {failed.at.toLocaleTimeString("en-IN", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-[15px] font-bold text-danger">{rupees(status.amount)}</span>
              <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
                {t("pay.failed.pill")}
              </span>
            </span>
          </div>

          {/* The buyer's first worry is their money, so it is answered before
              anything asks them to try again. */}
          <p className="mt-3 flex w-full items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-left text-[13px] text-warning">
            <Info size={15} className="mt-0.5 shrink-0" />
            {t("pay.failed.refundNote")}
          </p>

          {/* The gateway's own reason, when it gave one worth showing. */}
          {failed.message && (
            <p className="mt-3 text-[12px] text-cocoa/80">{failed.message}</p>
          )}

          <Button onClick={() => pay({ useWallet })} className="mt-6 w-full bg-danger hover:bg-danger/90">
            <RefreshCw size={17} /> {t("pay.failed.retry")}
          </Button>
          <button
            onClick={reset}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-full border border-line bg-card py-3 text-[14px] font-semibold text-ink hover:bg-beige/40"
          >
            <CreditCard size={17} /> {t("pay.failed.another")}
          </button>
          <Link
            href={`/orders/${orderId}`}
            className="mt-4 text-[13px] text-cocoa underline hover:text-ink"
          >
            {t("pay.failed.back")}
          </Link>
        </SlideIn>
      )}

      {stage === "done" && (
        <SlideIn direction="top" className="mt-8 flex flex-col items-center">
          {/* Success header — Figma "Order Confirmation" */}
          <span className="flex size-16 items-center justify-center rounded-full bg-success/10">
            <CheckCircle2 size={40} className="text-success" />
          </span>
          {/* Cash on delivery confirms the order without taking any money, so
              "Payment successful" would be untrue — the amount is still owed,
              in person, at the door. */}
          <p className="mt-4 text-center text-[18px] font-bold text-ink">
            {isCash ? t("pay.confirmedCash") : t("pay.success")}
          </p>
          <p className="mt-1 text-center text-[13px] text-cocoa">
            {isCash
              ? t("pay.payOnDelivery").replace("{amount}", rupees(payable))
              : isFood
                ? t("pay.successFood")
                : t("pay.successRide")}
          </p>
          <span className="mt-3 rounded-pill border border-success/40 bg-success/5 px-3 py-1 font-mono text-[11px] font-semibold text-success">
            Order ID: #{orderId.slice(-8).toUpperCase()}
          </span>

          {/* ETA banner */}
          <div className="mt-5 flex w-full items-center gap-3 rounded-card bg-accent px-4 py-3 text-white">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15">
              <Clock size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-white/80">
                {isFood ? "Estimated delivery time" : "Estimated pickup"}
              </p>
              <p className="text-[15px] font-bold">
                {isFood
                  ? `${d.etaMinutes ?? 30} to ${(d.etaMinutes ?? 30) + 15} minutes`
                  : `${d.etaMinutes ?? 6} min away`}
              </p>
            </div>
            <span className="flex items-center gap-1 rounded-pill bg-white/15 px-2 py-0.5 text-[10px] font-bold">
              <span className="size-1.5 animate-pulse rounded-full bg-white" /> LIVE
            </span>
          </div>

          {/* Delivery address (food) / trip (ride) */}
          {isFood && address && (
            <Card className="mt-3 w-full py-3">
              <div className="flex items-center gap-2.5">
                <MapPin size={15} className="shrink-0 text-accent" />
                <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  <span className="font-semibold">{address.label}</span>, {address.line1},{" "}
                  {address.city}
                </p>
                <Link
                  href="/profile/addresses"
                  className="shrink-0 text-[12px] font-semibold text-accent hover:underline"
                >
                  {t("foodOrder.change")}
                </Link>
              </div>
            </Card>
          )}
          {!isFood && (d.pickup || d.drop) && (
            <Card className="mt-3 w-full py-3">
              <p className="flex items-center gap-2 text-[13px] text-ink">
                <MapPin size={14} className="shrink-0 text-accent" />
                <span className="truncate">
                  {d.pickup} → {d.drop}
                </span>
              </p>
            </Card>
          )}

          {/* Order summary — itemised for cart orders */}
          <Card className="mt-3 w-full">
            <p className="text-[13px] font-bold text-ink">{t("pay.summary")}</p>
            <div className="mt-2 flex flex-col gap-1.5 text-[13px]">
              {d.items && d.items.length > 0 ? (
                d.items.map((i, idx) => (
                  <div key={idx} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate text-cocoa">
                      {i.name} × {i.qty}
                    </span>
                    <span className="shrink-0 text-ink">{rupees(i.pricePaise * i.qty)}</span>
                  </div>
                ))
              ) : (
                <div className="flex justify-between gap-3">
                  <span className="min-w-0 truncate text-cocoa">{status.title}</span>
                  <span className="shrink-0 text-ink">{rupees(status.amount)}</span>
                </div>
              )}
              <div className="my-1 h-px bg-line" />
              <div className="flex justify-between font-bold text-ink">
                <span>{t("bill.totalPaid")}</span>
                <span>{rupees(status.amount)}</span>
              </div>
              {walletCommitted > 0 && (
                <>
                  <div className="flex justify-between text-success">
                    <span>{t("pay.paidWithRewards")}</span>
                    <span>− {rupees(walletCommitted)}</span>
                  </div>
                  <div className="flex justify-between text-cocoa">
                    <span>{t("pay.charged")}</span>
                    <span>{rupees(payable)}</span>
                  </div>
                </>
              )}
            </div>
          </Card>

          {/* replace, not push: the money has moved, so this screen is spent.
              Pushing left it in the history it was finished with, and back from
              the tracking page landed on the checkout for an order already paid
              — which reads as "did it not go through?" — with the place-order
              screen one step further back, ready to charge for a second one. */}
          <div className="mt-6 flex w-full flex-col gap-3">
            <Button onClick={() => router.replace(`/orders/${orderId}`)} className="w-full">
              {isFood ? t("pay.trackOrder") : t("pay.trackRide")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => router.replace(`/orders/${orderId}?invoice=1`)}
              className="w-full"
            >
              {t("pay.viewInvoice")}
            </Button>
          </div>
        </SlideIn>
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
  tint,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  tint: string;
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
          <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[10px]", tint)}>
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
