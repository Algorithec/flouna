"use client";

// My Cart — Figma "My Cart Screen" adapted to the Radiues theme and brand
// rules: no network names, one Radiues price per line, server reprices at
// checkout. Quantities, optional cooking instructions, price details, and a
// sticky checkout bar.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  Minus,
  Plus,
  Trash2,
  Tag,
  ShieldCheck,
  ShoppingBag,
} from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { useCart } from "@/lib/cart";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { DishArt } from "@/components/food/DishArt";
import { useI18n } from "@/components/i18n/I18nContext";

export default function CartPage() {
  const router = useRouter();
  const { lines, setQty, remove, clear } = useCart();
  const { t } = useI18n();
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const itemsTotal = lines.reduce((s, l) => s + l.pricePaise * l.qty, 0);

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
          })),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        },
      });
      clear();
      router.push(`/pay/${d.order.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not place the order");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 pb-28 lg:px-6">
      <div className="flex items-center justify-between">
        <button
          onClick={() => router.push("/food")}
          className="flex items-center gap-1 text-[13px] font-medium text-cocoa hover:text-ink"
        >
          <ChevronLeft size={16} /> {t("nav.food")}
        </button>
        <h1 className="text-[18px] font-bold text-ink">{t("cart.title")}</h1>
        <span className="w-12" />
      </div>

      {lines.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-beige/70">
            <ShoppingBag size={24} className="text-cocoa" />
          </span>
          <p className="mt-3 text-[14px] font-semibold text-ink">{t("cart.empty")}</p>
          <p className="mt-1 text-[12px] text-cocoa">
            {t("cart.emptySub")}
          </p>
          <Button onClick={() => router.push("/food")} className="mt-5">
            {t("cart.browse")}
          </Button>
        </div>
      ) : (
        <>
          {/* Reassurance banner (Figma: "Yay! Your items are added…") */}
          <p className="mt-4 rounded-card border border-success/30 bg-success/5 px-3.5 py-2.5 text-[12px] text-success">
            {t("cart.banner")}
          </p>

          {/* Lines */}
          <div className="mt-4 flex flex-col gap-2.5">
            {lines.map((l) => (
              <Card key={`${l.dishId}-${l.platform}`}>
                <div className="flex items-center gap-3">
                  <DishArt name={l.name} size={48} />
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
                        aria-label="Decrease quantity"
                        onClick={() => setQty(l.dishId, l.platform, l.qty - 1)}
                        className="p-1.5 text-accent"
                      >
                        <Minus size={13} />
                      </button>
                      <span className="w-5 text-center text-[13px] font-bold text-ink">
                        {l.qty}
                      </span>
                      <button
                        aria-label="Increase quantity"
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

          {/* Price details — estimates; the server recomputes at checkout */}
          <Card className="mt-4">
            <p className="text-[14px] font-bold text-ink">{t("cart.priceDetails")}</p>
            <div className="mt-2 flex flex-col gap-1.5 text-[13px]">
              <div className="flex justify-between text-cocoa">
                <span>
                  {t("bill.itemTotal")} ({lines.reduce((s, l) => s + l.qty, 0)})
                </span>
                <span className="text-ink">{rupees(itemsTotal)}</span>
              </div>
              <div className="flex justify-between text-cocoa">
                <span>{t("cart.deliveryFees")}</span>
                <span className="text-ink">{t("cart.shownAtPay")}</span>
              </div>
              <div className="my-1 h-px bg-line" />
              <div className="flex justify-between font-bold text-ink">
                <span>{t("cart.toPay")}</span>
                <span>{rupees(itemsTotal)}</span>
              </div>
            </div>
          </Card>

          {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}

          <p className="mt-3 flex items-center justify-center gap-1 text-[11px] text-cocoa/70">
            <ShieldCheck size={12} /> {t("cart.secure")}
          </p>

          {/* Sticky checkout bar */}
          <div className="fixed inset-x-0 bottom-16 z-20 mx-auto max-w-xl px-4 lg:bottom-4 lg:px-6">
            <Button
              onClick={checkout}
              disabled={busy}
              className="h-[56px] w-full rounded-[22px] text-[15px] shadow-card"
            >
              {busy
                ? t("foodOrder.placing")
                : `${t("cart.checkout")} · ${rupees(itemsTotal)}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
