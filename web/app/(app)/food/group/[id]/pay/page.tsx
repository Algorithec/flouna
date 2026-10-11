"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Smartphone,
  CreditCard,
  Wallet,
  ShieldCheck,
  Info,
  Check,
} from "lucide-react";
import { api } from "@/lib/api";
import type { PayMethod } from "@/lib/payments/useCheckout";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { GroupHeader } from "@/components/food/GroupHeader";
import type { GroupCart, GroupShare } from "@/components/food/GroupCartTypes";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { FadeIn } from "@/components/ui/motion";
import { cn } from "@/lib/cn";

// Figma "Proceed to Payment": the method picker, then the bill.
//
// One deliberate departure from the frame. It lists Google Pay, PhonePe and
// Paytm as separate rows, each implying a linked account; we have no
// tokenisation and no linked accounts, so rows like that would be a lie about
// what happens on tap. UPI is one row that opens whichever app the phone has,
// which is also what actually occurs.
//
// The bill's numbers are the ones the server computed. Nothing here is
// hardcoded, including the fees the frame prints as fixed values.

// The same three the checkout can actually take. Net banking was a fourth row
// here and the payment screen has never offered it, so choosing it meant being
// asked again a screen later and handed UPI. The method chosen here is now
// carried to that screen instead of being collected and dropped: before this,
// a host who picked Cash on delivery was sent straight to a UPI default.
type Method = PayMethod;

export default function GroupPayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { t } = useI18n();
  const { toast } = useToast();
  const [cart, setCart] = useState<GroupCart | null>(null);
  const [method, setMethod] = useState<Method>("upi");
  const [hostUpi, setHostUpi] = useState("");
  const [busy, setBusy] = useState(false);
  const [shares, setShares] = useState<GroupShare[] | null>(null);

  useEffect(() => {
    api<GroupCart>(`/api/groups/${id}`)
      .then((c) => {
        setCart(c);
        if (!c.isHost) router.replace(`/food/group/${id}/cart`);
      })
      .catch(() => setCart(null));
  }, [id, router]);

  async function placeOrder() {
    setBusy(true);
    try {
      const d = await api<{ orderId: string; shares: GroupShare[] }>(
        `/api/groups/${id}/checkout`,
        {
          method: "POST",
          json: hostUpi.trim() ? { hostUpiId: hostUpi.trim() } : {},
        },
      );
      setShares(d.shares);
      // The combined order is real from here on, so the payment screen for it
      // is where the host belongs — opened on the method they just chose.
      router.push(`/pay/${d.orderId}?method=${method}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : t("grp.checkoutFailed"));
      setBusy(false);
    }
  }

  if (!cart) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <p className="text-[13px] text-cocoa">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-28 lg:max-w-2xl lg:px-6 lg:pb-10">
      <GroupHeader
        title={t("grp.proceedToPayment")}
        backTo={`/food/group/${id}/cart`}
        right={
          <span className="flex size-9 items-center justify-center rounded-full bg-success/10">
            <ShieldCheck size={17} className="text-success" />
          </span>
        }
      />

      <FadeIn y={8}>
        <Card>
          <p className="text-[16px] font-extrabold text-ink">{t("grp.chooseMethod")}</p>

          <p className="mt-3.5 text-[11px] font-bold uppercase tracking-wide text-cocoa">
            {t("grp.upi")}
          </p>
          <MethodRow
            active={method === "upi"}
            onClick={() => setMethod("upi")}
            icon={<Smartphone size={18} className="text-[#3b6fe0]" />}
            tint="bg-[#3b6fe0]/10"
            title={t("grp.anyUpiApp")}
            subtitle={t("grp.anyUpiAppSub")}
          />

          <p className="mt-4 text-[11px] font-bold uppercase tracking-wide text-cocoa">
            {t("grp.cardHeading")}
          </p>
          <MethodRow
            active={method === "card"}
            onClick={() => setMethod("card")}
            icon={<CreditCard size={18} className="text-[#8b5cf6]" />}
            tint="bg-[#8b5cf6]/10"
            title={t("grp.card")}
            subtitle={t("grp.cardSub")}
          />

          <p className="mt-4 text-[11px] font-bold uppercase tracking-wide text-cocoa">
            {t("grp.otherOptions")}
          </p>
          <MethodRow
            active={method === "cash"}
            onClick={() => setMethod("cash")}
            icon={<Wallet size={18} className="text-success" />}
            tint="bg-success/10"
            title={t("grp.cash")}
            subtitle={t("grp.cashSub")}
          />
        </Card>
      </FadeIn>

      {/* Collecting from friends. Optional, and honest about being a link
          rather than a charge: nobody's account is debited by us. */}
      <Card className="mt-4">
        <p className="text-[15px] font-extrabold text-ink">{t("grp.collectShares")}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-cocoa">
          {t("grp.collectSharesSub")}
        </p>
        <input
          value={hostUpi}
          onChange={(e) => setHostUpi(e.target.value.trim())}
          placeholder={t("grp.upiPlaceholder")}
          inputMode="email"
          autoCapitalize="none"
          className="mt-3 h-[46px] w-full rounded-pill border border-line bg-cream px-4 text-[14px] text-ink outline-none focus:border-accent"
        />
      </Card>

      {/* The bill */}
      <Card className="mt-4">
        <p className="text-[15px] font-extrabold text-ink">{t("grp.billSummary")}</p>
        <div className="mt-3 flex flex-col gap-2.5 text-[14px]">
          <Row label={t("bill.itemTotal")} value={rupees(cart.totalPaise)} />
          <Row label={t("cart.deliveryFees")} value={t("cart.shownAtPay")} muted />
          <div className="my-1 h-px bg-line" />
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-extrabold text-ink">{t("cart.toPay")}</span>
            <span className="text-[19px] font-extrabold text-ink">
              {rupees(cart.totalPaise)}
            </span>
          </div>
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-cocoa">
            <Info size={12} className="mt-0.5 shrink-0" />
            {t("grp.feesAtPay")}
          </p>
        </div>
      </Card>

      {shares && (
        <Card className="mt-4">
          <p className="text-[15px] font-extrabold text-ink">{t("grp.eachOwes")}</p>
          <div className="mt-2.5 flex flex-col gap-2">
            {shares.map((s) => (
              <div key={s.userId} className="flex items-center gap-2 text-[13px]">
                <Check size={13} className="shrink-0 text-success" />
                <span className="min-w-0 flex-1 truncate text-ink">{s.name}</span>
                <span className="font-bold text-ink">{rupees(s.sharePaise)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="fixed inset-x-0 bottom-16 z-20 mx-auto max-w-xl px-4 lg:static lg:mt-6 lg:px-0">
        <button
          onClick={placeOrder}
          disabled={busy || cart.status !== "open" || cart.items.length === 0}
          className="flex h-[58px] w-full items-center gap-3 rounded-[22px] bg-accent px-4 text-white shadow-card transition-colors hover:bg-[#d4570f] disabled:opacity-60"
        >
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-[12px] text-white/85">{t("grp.paySecurely")}</span>
            <span className="block text-[16px] font-extrabold">
              {rupees(cart.totalPaise)}
            </span>
          </span>
          <span className="shrink-0 text-[15px] font-bold">
            {busy ? t("foodOrder.placing") : t("grp.placeOrder")}
          </span>
        </button>
      </div>
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
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "tap-target mt-2 flex w-full items-center gap-3 rounded-[16px] border px-3.5 py-3 text-left transition-colors",
        active ? "border-accent bg-accent-soft/40" : "border-line bg-card hover:bg-beige/30",
      )}
    >
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[12px]", tint)}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-bold text-ink">{title}</span>
        <span className="block truncate text-[12px] text-cocoa">{subtitle}</span>
      </span>
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border-2",
          active ? "border-accent bg-accent" : "border-line",
        )}
      >
        {active && <Check size={12} className="text-white" />}
      </span>
    </button>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-cocoa">{label}</span>
      <span className={muted ? "text-cocoa" : "font-medium text-ink"}>{value}</span>
    </div>
  );
}
