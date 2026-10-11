"use client";

import { useEffect, useState } from "react";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { useBackTo } from "@/lib/navHistory";
import {
  ArrowLeft,
  Plus,
  CreditCard,
  Smartphone,
  Wallet,
  Trash2,
  ShieldCheck,
  ChevronRight,
  Star,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/components/i18n/I18nContext";
import { PaymentBrandMark } from "@/components/profile/PaymentBrandMark";
import { Select } from "@/components/ui/Select";

// Figma "Payment Methods": saved methods list, each row a brand mark, a
// label/detail pair, and either a Default badge or a chevron; a trailing
// "Add Payment Method" row; a security reassurance card at the foot.
//
// The chevron is the design's own affordance and it leads somewhere: tapping a
// row opens that method's actions (make it the default, remove it) rather than
// crowding two controls into every row.
//
// Deliberately not a card vault — see the PaymentMethod model's own comment.
// This never asks for a full card number or CVV, only what's needed to
// recognise a saved method in a list: brand, last 4, expiry. A UPI ID is a
// real identifier, so that one actually authenticates as entered.

type Method = {
  id: string;
  type: "card" | "upi" | "wallet";
  label: string;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  vpa: string | null;
  isDefault: boolean;
};

const CARD_BRANDS = ["Visa", "Mastercard", "Rupay", "Amex"] as const;
// The wallets that actually operate in India. Free text on the server, but a
// fixed list here keeps saved labels consistent enough to draw a mark for.
const WALLETS = ["Paytm Wallet", "PhonePe Wallet", "Amazon Pay", "Mobikwik"] as const;

type AddType = "card" | "upi" | "wallet";

export default function PaymentMethodsPage() {
  const goBack = useBackTo("/profile");
  const { toast } = useToast();
  const { t } = useI18n();
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<Method | null>(null);
  const [type, setType] = useState<AddType>("card");
  const [brand, setBrand] = useState<(typeof CARD_BRANDS)[number]>("Visa");
  const [wallet, setWallet] = useState<(typeof WALLETS)[number]>("Paytm Wallet");
  const [last4, setLast4] = useState("");
  const [expiry, setExpiry] = useState(""); // MM/YY
  const [vpa, setVpa] = useState("");
  const [busy, setBusy] = useState(false);
  useEscapeToClose(Boolean(acting), () => setActing(null));
  useEscapeToClose(adding && !busy, () => setAdding(false));
  const [error, setError] = useState("");

  function load() {
    api<{ methods: Method[] }>("/api/users/payment-methods")
      .then((d) => setMethods(d.methods))
      .catch(() => setMethods([]));
  }
  useEffect(load, []);

  async function addMethod(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const body =
        type === "card"
          ? (() => {
              const [mm, yy] = expiry.split("/").map((s) => s.trim());
              const expiryMonth = Number(mm);
              const expiryYear = Number(yy) < 100 ? 2000 + Number(yy) : Number(yy);
              if (!expiryMonth || !expiryYear || last4.length !== 4) {
                // Was an English literal on a screen that is otherwise fully
                // translated, so the one message a Hindi or Telugu customer
                // actually hits while adding a card arrived in English.
                throw new Error(t("pp.pay.cardFormat"));
              }
              return { type, label: brand, last4, expiryMonth, expiryYear };
            })()
          : type === "upi"
            ? { type, label: "UPI ID", vpa: vpa.trim() }
            : { type, label: wallet };
      const d = await api<{ method: Method }>("/api/users/payment-methods", {
        method: "POST",
        json: body,
      });
      setMethods((m) => [...(m ?? []), d.method]);
      setAdding(false);
      setLast4("");
      setExpiry("");
      setVpa("");
      toast(t("pp.pay.added"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pp.pay.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const prev = methods;
    setActing(null);
    setMethods((m) => m?.filter((x) => x.id !== id) ?? null);
    try {
      await api(`/api/users/payment-methods/${id}`, { method: "DELETE" });
      toast(t("pp.pay.removed"));
    } catch {
      setMethods(prev ?? null);
      toast(t("pp.pay.removeFailed"));
    }
  }

  async function setDefault(id: string) {
    const prev = methods;
    setActing(null);
    setMethods((m) => m?.map((x) => ({ ...x, isDefault: x.id === id })) ?? null);
    try {
      await api(`/api/users/payment-methods/${id}/default`, { method: "PATCH" });
      toast(t("pp.pay.defaultUpdated"));
    } catch {
      setMethods(prev ?? null);
      toast(t("pp.pay.defaultFailed"));
    }
  }

  /** Second line of a row, per method type. */
  function detail(m: Method) {
    if (m.type === "card") {
      return `${t("pp.pay.expires")} ${String(m.expiryMonth).padStart(2, "0")}/${String(m.expiryYear).slice(-2)}`;
    }
    return m.type === "upi" ? (m.vpa ?? "") : t("pp.pay.connected");
  }

  function title(m: Method) {
    return m.type === "card" ? `${m.label} •••• ${m.last4}` : m.label;
  }

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg"
          >
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <h1 className="flex-1 text-center text-[17px] font-extrabold text-acct-ink">
            {t("pp.profile.payments")}
          </h1>
          <button
            onClick={() => {
              setError("");
              setAdding(true);
            }}
            aria-label={t("pp.pay.addMethod")}
            className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-acct-tint text-acct-accent transition-colors hover:bg-acct-accent/15"
          >
            <Plus size={20} />
          </button>
        </div>

        <p className="mb-2 px-1 text-[13px] font-semibold text-acct-muted">
          {t("pp.pay.saved")}
        </p>

        <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
          {methods === null ? (
            <div className="px-4 py-6 text-center text-[13px] text-acct-muted">
              {t("common.loading")}
            </div>
          ) : methods.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-acct-muted">
              {t("pp.pay.none")}
            </div>
          ) : (
            methods.map((m, i) => (
              <button
                key={m.id}
                onClick={() => setActing(m)}
                aria-label={`Options for ${title(m)}`}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-acct-bg",
                  i < methods.length - 1 && "border-b border-line",
                )}
              >
                <PaymentBrandMark type={m.type} label={m.label} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold text-acct-ink">
                    {title(m)}
                  </span>
                  <span
                    className={cn(
                      "block truncate text-[12px]",
                      m.type === "wallet"
                        ? "font-semibold text-success"
                        : "text-acct-muted",
                    )}
                  >
                    {detail(m)}
                  </span>
                </span>
                {m.isDefault ? (
                  <span className="shrink-0 rounded-pill bg-success/10 px-2.5 py-1 text-[11px] font-bold text-success">
                    {t("pp.pay.default")}
                  </span>
                ) : (
                  <ChevronRight size={17} className="shrink-0 text-acct-muted" />
                )}
              </button>
            ))
          )}

          <button
            onClick={() => {
              setError("");
              setAdding(true);
            }}
            className="flex w-full items-center gap-3 border-t border-line px-4 py-3.5 text-left transition-colors hover:bg-acct-bg"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-acct-tint text-acct-accent">
              <Plus size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-acct-accent">
                {t("pp.pay.addMethod")}
              </span>
              <span className="block text-[12px] text-acct-muted">
                {t("pp.pay.addMethodSub")}
              </span>
            </span>
            <ChevronRight size={17} className="shrink-0 text-acct-muted" />
          </button>
        </div>

        <p className="mt-4 flex items-center justify-center gap-2 rounded-[16px] bg-card px-4 py-3.5 text-[12px] text-acct-muted shadow-soft">
          <ShieldCheck size={14} className="shrink-0 text-success" />
          {t("pp.pay.secure")}
        </p>
      </div>

      {/* Row actions — what the chevron leads to. */}
      {acting && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 lg:items-center"
          onClick={() => setActing(null)}
        >
          <div
            role="dialog"
            aria-label={`Options for ${title(acting)}`}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-3xl bg-card p-5 lg:rounded-3xl"
          >
            <div className="flex items-center gap-3">
              <PaymentBrandMark type={acting.type} label={acting.label} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold text-acct-ink">
                  {title(acting)}
                </span>
                <span className="block truncate text-[12px] text-acct-muted">
                  {detail(acting)}
                </span>
              </span>
              <button
                onClick={() => setActing(null)}
                aria-label={t("common.close")}
                className="rounded-full p-1.5 text-acct-muted hover:bg-acct-bg"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              {!acting.isDefault && (
                <button
                  onClick={() => setDefault(acting.id)}
                  className="flex items-center gap-3 rounded-[14px] border border-line px-4 py-3.5 text-left transition-colors hover:bg-acct-bg"
                >
                  <Star size={17} className="shrink-0 text-acct-accent" />
                  <span className="text-[15px] font-semibold text-acct-ink">
                    {t("pp.pay.setDefault")}
                  </span>
                </button>
              )}
              <button
                onClick={() => remove(acting.id)}
                className="flex items-center gap-3 rounded-[14px] border border-line px-4 py-3.5 text-left text-danger transition-colors hover:bg-danger-soft"
              >
                <Trash2 size={17} className="shrink-0" />
                <span className="text-[15px] font-semibold">{t("pp.pay.remove")}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add method sheet */}
      {adding && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 lg:items-center"
          onClick={() => !busy && setAdding(false)}
        >
          <div
            role="dialog"
            aria-label={t("pp.pm.addMethod")}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-3xl bg-card p-5 lg:rounded-3xl"
          >
            <div className="flex items-center justify-between">
              <p className="text-[16px] font-bold text-acct-ink">{t("pp.pay.addMethod")}</p>
              <button
                onClick={() => setAdding(false)}
                aria-label={t("common.close")}
                className="rounded-full p-1.5 text-acct-muted hover:bg-acct-bg"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              {(
                [
                  ["card", t("pp.pay.card"), CreditCard],
                  ["upi", "UPI", Smartphone],
                  ["wallet", t("pp.pay.wallet"), Wallet],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setType(value);
                    setError("");
                  }}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-pill border py-2.5 text-[13px] font-semibold",
                    type === value
                      ? "border-acct-accent bg-acct-tint text-acct-accent"
                      : "border-line text-acct-muted",
                  )}
                >
                  <Icon size={15} /> {label}
                </button>
              ))}
            </div>

            <form onSubmit={addMethod} className="mt-4 flex flex-col gap-3">
              {type === "card" && (
                <>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-acct-muted">{t("pp.pay.cardBrand")}</span>
                    <Select
                      value={brand}
                      label={t("pp.pay.cardBrand")}
                      options={CARD_BRANDS.map((b) => ({ value: b, label: b }))}
                      onChange={(v) => setBrand(v as (typeof CARD_BRANDS)[number])}
                    />
                  </label>
                  {/* Last 4 digits only, never a full PAN — this list exists
                      to recognise a method, not to charge it. */}
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-acct-muted">{t("pp.pay.last4")}</span>
                    <input
                      inputMode="numeric"
                      maxLength={4}
                      value={last4}
                      onChange={(e) =>
                        setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))
                      }
                      placeholder="4242"
                      className="h-12 rounded-[12px] border border-line bg-acct-bg px-3.5 text-[15px] text-acct-ink outline-none focus:border-acct-accent"
                      required
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-acct-muted">{t("pp.pay.expiry")}</span>
                    <input
                      value={expiry}
                      onChange={(e) =>
                        setExpiry(e.target.value.replace(/[^\d/]/g, "").slice(0, 5))
                      }
                      placeholder="12/28"
                      className="h-12 rounded-[12px] border border-line bg-acct-bg px-3.5 text-[15px] text-acct-ink outline-none focus:border-acct-accent"
                      required
                    />
                  </label>
                </>
              )}

              {type === "upi" && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-acct-muted">{t("pp.pay.upiId")}</span>
                  <input
                    value={vpa}
                    onChange={(e) => setVpa(e.target.value)}
                    placeholder="name@bank"
                    className="h-12 rounded-[12px] border border-line bg-acct-bg px-3.5 text-[15px] text-acct-ink outline-none focus:border-acct-accent"
                    required
                  />
                </label>
              )}

              {type === "wallet" && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-acct-muted">{t("pp.pay.wallet")}</span>
                  <Select
                    value={wallet}
                    label={t("pp.pay.wallet")}
                    options={WALLETS.map((w) => ({ value: w, label: w }))}
                    onChange={(v) => setWallet(v as (typeof WALLETS)[number])}
                  />
                  <span className="text-[12px] text-acct-muted">
                    {t("pp.pay.walletHint")}
                  </span>
                </label>
              )}

              {error && (
                <p role="alert" className="text-[13px] text-danger">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="mt-1 h-[52px] w-full rounded-pill bg-acct-accent text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {busy ? t("pp.pay.adding") : t("pp.pay.addMethod")}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
