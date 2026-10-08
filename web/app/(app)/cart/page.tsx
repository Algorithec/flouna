"use client";

// My Cart — Figma "My Cart Screen" adapted to the Flouna theme and brand
// rules: no network names, one Flouna price per line, server reprices at
// checkout. Quantities, optional cooking instructions, price details, and a
// sticky checkout bar.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  Minus,
  Plus,
  Trash2,
  Tag,
  ShieldCheck,
  ShoppingBag,
  MapPin,
} from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { useCart } from "@/lib/cart";
import { Card } from "@/components/ui/Card";
import { StateScreen, StateGlyph } from "@/components/ui/StateScreen";
import { Button } from "@/components/ui/Button";
import { DishArt } from "@/components/food/DishArt";
import { useBackTo } from "@/lib/navHistory";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { FadeIn, MOTION } from "@/components/ui/motion";

type AppliedCoupon = { code: string; description: string; discountPaise: number };

/**
 * The bill, priced by the server from the same code the order route uses.
 *
 * This screen used to add its own total from the prices stored when each item
 * was added. Those are per-item effective prices, so two of something counted
 * the delivery fee twice and took its offer off twice, while the order route
 * charges one delivery fee and one offer. The screen therefore promised a
 * total nobody was going to charge. Now it asks.
 */
type CartBill = {
  itemsTotalPaise: number;
  deliveryFeePaise: number;
  convenienceFeePaise: number;
  offersDiscountPaise: number;
  savedPaise: number;
  totalPaise: number;
};
type OfferedCoupon = { code: string; description: string; minOrderPaise: number };

type AddressLine = {
  label: string;
  line1: string;
  city: string;
  isDefault: boolean;
};

export default function CartPage() {
  const router = useRouter();
  const { lines, setQty, remove, clear } = useCart();
  const { t } = useI18n();
  const back = useBackTo("/food");
  const { toast } = useToast();
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // undefined = still loading, null = none saved (checkout would be rejected).
  const [address, setAddress] = useState<AddressLine | null | undefined>(undefined);
  const [codeInput, setCodeInput] = useState("");
  const [coupon, setCoupon] = useState<AppliedCoupon | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState("");
  const [offers, setOffers] = useState<OfferedCoupon[]>([]);
  const [bill, setBill] = useState<CartBill | null>(null);

  useEffect(() => {
    api<{ addresses: AddressLine[] }>("/api/users/addresses")
      .then((d) => setAddress(d.addresses.find((a) => a.isDefault) ?? d.addresses[0] ?? null))
      .catch(() => setAddress(null));
    api<{ coupons: OfferedCoupon[] }>("/api/coupons?domain=food")
      .then((d) => setOffers(d.coupons))
      .catch(() => setOffers([]));
  }, []);

  // Preview the discount. The server re-checks the code when the order is
  // actually created, so this is only for showing the buyer what they'll save.
  async function applyCoupon() {
    setCouponBusy(true);
    setCouponError("");
    try {
      const d = await api<AppliedCoupon>("/api/coupons/validate", {
        method: "POST",
        json: {
          code: codeInput.trim(),
          domain: "food",
          subtotalPaise: itemsTotal,
        },
      });
      setCoupon(d);
      toast(`${d.code} applied, you save ${rupees(d.discountPaise)}`);
    } catch (e) {
      setCoupon(null);
      setCouponError(e instanceof Error ? e.message : "Could not apply that code");
    } finally {
      setCouponBusy(false);
    }
  }

  // Only a fallback now, for a preview that could not be fetched. It cannot be
  // the amount charged, because it prices each line as though it were the whole
  // order.
  const estimateTotal = lines.reduce((s, l) => s + l.pricePaise * l.qty, 0);
  const itemsTotal = bill?.itemsTotalPaise ?? estimateTotal;
  const toPay = Math.max(
    0,
    (bill ? bill.totalPaise : estimateTotal) - (coupon?.discountPaise ?? 0),
  );

  // Re-priced whenever the cart changes, keyed on what actually affects the
  // bill so editing the cooking instructions does not re-ask.
  const cartKey = lines.map((l) => `${l.dishId}@${l.platform}x${l.qty}`).join(",");
  useEffect(() => {
    // Nothing to price, and nothing to clear either: an empty cart shows the
    // empty state rather than a summary, and any refill changes the key below
    // and re-prices.
    if (lines.length === 0) return;
    let active = true;
    api<{ bill: CartBill }>("/api/orders/preview", {
      method: "POST",
      json: { items: lines.map((l) => ({ dishId: l.dishId, platform: l.platform, qty: l.qty })) },
    })
      .then((d) => active && setBill(d.bill))
      // No bill rather than a wrong one: the summary falls back to an estimate
      // and says so.
      .catch(() => active && setBill(null));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey]);

  async function checkout() {
    if (lines.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const d = await api<{ order: { id: string } }>("/api/orders", {
        method: "POST",
        json: {
          domain: "food",
          items: lines.map((l) => ({
            dishId: l.dishId,
            platform: l.platform,
            qty: l.qty,
            // Pairs this line with the ranking it came from, so the engine
            // learns what was chosen and not only what was offered.
            ...(l.decisionId ? { decisionId: l.decisionId } : {}),
          })),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
          ...(coupon ? { couponCode: coupon.code } : {}),
        },
      });
      clear();
      router.push(`/pay/${d.order.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ct.placeFailed"));
      setBusy(false);
    }
  }

  return (
    <FadeIn duration={MOTION.fast} className="mx-auto w-full max-w-xl px-4 py-6 pb-28 lg:max-w-5xl lg:px-6 lg:pb-10">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={back}
          className="tap-target flex items-center gap-1 text-[13px] font-medium text-cocoa hover:text-ink"
        >
          <ChevronLeft size={16} /> {t("nav.food")}
        </button>
        <h1 className="text-[18px] font-bold text-ink">{t("cart.title")}</h1>
        <span className="w-12" />
      </div>

      {lines.length === 0 ? (
        // Figma "No items yet" — same layout as every other empty state, so
        // an empty cart reads as part of the product rather than a dead end.
        <StateScreen
          illustration={<StateGlyph icon={ShoppingBag} />}
          title={t("cart.empty")}
          message={t("cart.emptySub")}
          primary={{ label: t("cart.browse"), href: "/food" }}
        />
      ) : (
        <>
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6">
          <div className="min-w-0">
          {/* Reassurance banner (Figma: "Yay! Your items are added…") */}
          <p className="mt-4 rounded-card border border-success/30 bg-success/5 px-3.5 py-2.5 text-[12px] text-success">
            {t("cart.banner")}
          </p>

          {/* Lines */}
          <div className="mt-4 flex flex-col gap-2.5">
            {lines.map((l) => (
              <Card key={`${l.dishId}-${l.platform}`}>
                <div className="flex items-center gap-3">
                  <DishArt name={l.name} image={l.image} size={48} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-bold text-ink">{l.name}</p>
                    <p className="truncate text-[12px] text-cocoa">{l.restaurant}</p>
                    <p className="mt-0.5 text-[12px] text-cocoa">
                      {rupees(l.pricePaise)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <div className="flex items-center gap-1 rounded-pill border border-accent/50 px-1">
                      <button
                        aria-label={t("fh.less")}
                        onClick={() => setQty(l.dishId, l.platform, l.qty - 1)}
                        className="p-1.5 text-accent"
                      >
                        <Minus size={13} />
                      </button>
                      <span className="w-5 text-center text-[13px] font-bold text-ink">
                        {l.qty}
                      </span>
                      <button
                        aria-label={t("fh.more")}
                        onClick={() => setQty(l.dishId, l.platform, l.qty + 1)}
                        className="p-1.5 text-accent"
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-[14px] font-bold text-ink">
                        {rupees(l.pricePaise * l.qty)}
                      </p>
                      <button
                        aria-label={`Remove ${l.name}`}
                        onClick={() => remove(l.dishId, l.platform)}
                        className="rounded-full p-1 text-cocoa/60 hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Cooking instructions */}
          <Card className="mt-4 py-3">
            <label className="flex items-start gap-2.5">
              <Tag size={15} className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-ink">
                  {t("cart.instructions")}
                </span>
                <input
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value.slice(0, 300))}
                  placeholder={t("cart.instructionsPh")}
                  className="mt-1 w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-cocoa/50"
                />
              </span>
            </label>
          </Card>

          </div>

          {/* Checkout panel — sticky beside the items on desktop */}
          <div className="lg:sticky lg:top-6">
          {/* Promo code */}
          <Card className="mt-4 py-3">
            <div className="flex items-center gap-2.5">
              <Tag size={15} className="shrink-0 text-accent" />
              {coupon ? (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-bold text-success">
                      {t("ct.applied").replace("{code}", coupon.code)}
                    </span>
                    <span className="block truncate text-[11px] text-cocoa">
                      {coupon.description} ·{" "}
                      {t("ct.saving").replace("{amount}", rupees(coupon.discountPaise))}
                    </span>
                  </span>
                  <button
                    onClick={() => {
                      setCoupon(null);
                      setCodeInput("");
                      setCouponError("");
                    }}
                    className="shrink-0 text-[12px] font-semibold text-cocoa hover:text-danger"
                  >
                    {t("ct.remove")}
                  </button>
                </>
              ) : (
                <>
                  <input
                    value={codeInput}
                    onChange={(e) => {
                      setCodeInput(e.target.value.toUpperCase().slice(0, 24));
                      setCouponError("");
                    }}
                    placeholder={t("ct.promoPlaceholder")}
                    className="min-w-0 flex-1 bg-transparent text-[13px] uppercase text-ink outline-none placeholder:normal-case placeholder:text-cocoa/50"
                  />
                  <button
                    onClick={applyCoupon}
                    disabled={couponBusy || codeInput.trim().length < 2}
                    className="shrink-0 text-[12px] font-semibold text-accent hover:underline disabled:opacity-40"
                  >
                    {couponBusy ? t("pp.priv.checking") : t("ct.apply")}
                  </button>
                </>
              )}
            </div>
            {couponError && (
              <p className="mt-1.5 pl-[26px] text-[11px] text-danger">{couponError}</p>
            )}
            {!coupon && offers.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 pl-[26px]">
                {offers.map((o) => (
                  <button
                    key={o.code}
                    onClick={() => setCodeInput(o.code)}
                    title={o.description}
                    className="rounded-pill border border-dashed border-accent/50 px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft"
                  >
                    {o.code}
                  </button>
                ))}
              </div>
            )}
          </Card>

          {/* Delivery address — required, so it's shown before the bill */}
          <Card className="mt-4 py-3">
            <div className="flex items-center gap-2.5">
              <MapPin size={16} className="shrink-0 text-accent" />
              {address === undefined ? (
                <p className="text-[13px] text-cocoa">{t("ct.loadingAddress")}</p>
              ) : address ? (
                <p className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  <span className="font-semibold">{address.label}</span>,{" "}
                  {address.line1}, {address.city}
                </p>
              ) : (
                <p className="min-w-0 flex-1 text-[13px] text-cocoa">
                  {t("ct.noAddress")}
                </p>
              )}
              <Link
                href="/profile/addresses"
                className="shrink-0 text-[12px] font-semibold text-accent hover:underline"
              >
                {address ? t("ct.change") : t("ct.add")}
              </Link>
            </div>
          </Card>

          {/* Order Summary — the design's typography (Figma 2265:1975), but not
              its numbers. That frame prints "Delivery Fee FREE" and a flat
              "Platform Fee ₹5" as fixed values; fees here are computed
              server-side at checkout, so quoting them now would be a price
              promise this screen can't keep. The line stays honest instead. */}
          <Card className="mt-4">
            <p className="text-[17px] font-extrabold text-ink">{t("ct.summary")}</p>
            <div className="mt-3 flex flex-col gap-2.5 text-[14px]">
              <div className="flex justify-between">
                <span className="text-cocoa">
                  {t("bill.itemTotal")} ({lines.reduce((s, l) => s + l.qty, 0)})
                </span>
                <span className="font-medium text-ink">{rupees(itemsTotal)}</span>
              </div>
              {/* Every fee and offer as the server priced them. The frame
                  prints a fixed "FREE" and "₹5"; these are the real numbers,
                  and a free delivery is only stated when the fee is actually
                  nothing. */}
              {bill ? (
                <>
                  {bill.offersDiscountPaise > 0 && (
                    <div className="flex justify-between text-success">
                      <span>{t("bill.offers")}</span>
                      <span className="font-semibold">
                        − {rupees(bill.offersDiscountPaise)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-cocoa">{t("cart.deliveryFees")}</span>
                    <span className="font-medium text-ink">
                      {bill.deliveryFeePaise === 0 ? "FREE" : rupees(bill.deliveryFeePaise)}
                    </span>
                  </div>
                  {bill.convenienceFeePaise > 0 && (
                    <div className="flex justify-between">
                      <span className="text-cocoa">{t("bill.convenienceFee")}</span>
                      <span className="font-medium text-ink">
                        {rupees(bill.convenienceFeePaise)}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex justify-between">
                  <span className="text-cocoa">{t("cart.deliveryFees")}</span>
                  <span className="font-medium text-ink">{t("cart.shownAtPay")}</span>
                </div>
              )}
              {coupon && (
                <div className="flex justify-between text-success">
                  <span>{t("ct.promo")}{" "}{coupon.code}</span>
                  <span className="font-semibold">− {rupees(coupon.discountPaise)}</span>
                </div>
              )}
              <div className="my-1 h-px bg-line" />
              <div className="flex items-center justify-between">
                <span className="text-[16px] font-extrabold text-ink">
                  {/* "To pay (est.)" was the honest label while this screen
                      added the total up itself. With the server's bill it is
                      the amount charged, so the hedge goes. */}
                  {bill ? t("pay.toPay") : t("cart.toPay")}
                </span>
                <span className="text-[20px] font-extrabold text-ink">
                  {rupees(toPay)}
                </span>
              </div>
            </div>
          </Card>

          {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}

          <p className="mt-3 flex items-center justify-center gap-1 text-[11px] text-cocoa/70">
            <ShieldCheck size={12} /> {t("cart.secure")}
          </p>

          {/* Checkout action — fixed bottom bar on mobile, inside the
              summary panel on desktop */}
          <div className="fixed inset-x-0 bottom-16 z-20 mx-auto max-w-xl px-4 lg:static lg:mt-4 lg:max-w-none lg:px-0">
            {address === null ? (
              // Checkout would be rejected server-side without an address —
              // send the buyer to add one instead of failing at the last step.
              <Link
                href="/profile/addresses"
                className="flex h-[56px] w-full items-center justify-center gap-2 rounded-[22px] bg-accent text-[15px] font-semibold text-white shadow-card transition-colors hover:bg-[#d4570f]"
              >
                <MapPin size={17} /> {t("ct.addAddress")}
              </Link>
            ) : (
              <Button
                onClick={checkout}
                disabled={busy || address === undefined}
                className="h-[56px] w-full rounded-[22px] text-[15px] shadow-card"
              >
                {busy
                  ? t("foodOrder.placing")
                  : `${t("cart.checkout")} · ${rupees(toPay)}`}
              </Button>
            )}
          </div>
          </div>
          </div>
        </>
      )}
    </FadeIn>
  );
}
