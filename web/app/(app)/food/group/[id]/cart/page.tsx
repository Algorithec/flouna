"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Minus, Plus, Trash2, ShoppingBag, Utensils } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { GroupHeader } from "@/components/food/GroupHeader";
import { DishArt } from "@/components/food/DishArt";
import type { GroupCart, GroupItem } from "@/components/food/GroupCartTypes";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { FadeIn } from "@/components/ui/motion";

// Figma "Your Cart": the order grouped by the person who chose it, because in a
// group order "who ordered the paneer" is the question people actually ask.
//
// You can only change your own lines. The server enforces it too; here it is
// the difference between a stepper and a read-only row, so nobody taps a
// control that was never going to work.

const POLL_MS = 4000;

export default function GroupCartPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { t } = useI18n();
  const { toast } = useToast();
  const [cart, setCart] = useState<GroupCart | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<GroupCart>(`/api/groups/${id}`).then(setCart).catch(() => {});
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function removeItem(item: GroupItem) {
    setBusy(true);
    try {
      setCart(await api<GroupCart>(`/api/groups/${id}/items/${item.id}`, { method: "DELETE" }));
    } catch (e) {
      toast(e instanceof Error ? e.message : t("grp.removeFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Quantity is expressed as separate lines server-side, so "one more" is one
  // more line and "one fewer" removes the most recent of them. That keeps the
  // stepper honest without inventing an update route the cart does not have.
  async function addOne(item: GroupItem) {
    setBusy(true);
    try {
      setCart(
        await api<GroupCart>(`/api/groups/${id}/items`, {
          method: "POST",
          json: { dishId: item.dishId, qty: 1 },
        }),
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : t("grp.addFailed"));
    } finally {
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

  // One block per person, in the order they joined, with their own lines.
  const groups = cart.members
    .map((m) => ({
      member: m,
      items: cart.items.filter((i) => i.userId === m.userId),
    }))
    .filter((g) => g.items.length > 0);

  const itemCount = cart.items.reduce((s, i) => s + i.qty, 0);

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-28 lg:max-w-2xl lg:px-6 lg:pb-10">
      <GroupHeader
        title={t("grp.yourCart")}
        subtitle={t("grp.membersItems")
          .replace("{m}", String(cart.members.length))
          .replace("{i}", String(itemCount))}
        backTo={`/food/group/${id}/menu`}
        chatHref={`/food/group/${id}/chat`}
      />

      {groups.length === 0 ? (
        <Card className="mt-2 py-10 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-soft">
            <ShoppingBag size={24} className="text-accent" />
          </span>
          <p className="mt-3 text-[15px] font-bold text-ink">{t("grp.cartEmpty")}</p>
          <p className="mt-1 text-[13px] text-cocoa">{t("grp.cartEmptySub")}</p>
          <Link
            href={`/food/group/${id}/menu`}
            className="mt-4 inline-flex h-[46px] items-center gap-2 rounded-pill bg-accent px-5 text-[14px] font-bold text-white"
          >
            <Utensils size={16} /> {t("grp.openMenu")}
          </Link>
        </Card>
      ) : (
        <FadeIn className="flex flex-col gap-3">
          {groups.map(({ member, items }) => (
            <Card key={member.userId} className="py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[14px] font-bold text-accent-ink">
                  {member.name.trim().charAt(0).toUpperCase() || "?"}
                </span>
                <p className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">
                  {member.name}
                </p>
                {member.isYou && (
                  <span className="shrink-0 rounded-pill bg-ink px-2.5 py-0.5 text-[11px] font-bold text-white">
                    {t("grp.youBadge")}
                  </span>
                )}
                <span className="shrink-0 text-[14px] font-extrabold text-ink">
                  {rupees(member.subtotalPaise)}
                </span>
              </div>

              <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
                {items.map((item) => (
                  <div key={item.id} className="flex items-center gap-3">
                    <DishArt name={item.name}
                      className="size-[60px] shrink-0 rounded-[14px]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-bold text-ink">{item.name}</p>
                      <p className="mt-0.5 text-[15px] font-extrabold text-ink">
                        {rupees(item.pricePaise * item.qty)}
                      </p>
                    </div>
                    {item.isYou ? (
                      <div className="flex shrink-0 items-center gap-1 rounded-pill border border-line px-1 py-1">
                        <button
                          onClick={() => removeItem(item)}
                          disabled={busy}
                          aria-label={t("grp.decrease")}
                          className="tap-target flex size-7 items-center justify-center rounded-full text-cocoa transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                        >
                          {item.qty > 1 ? <Minus size={14} /> : <Trash2 size={13} />}
                        </button>
                        <span className="min-w-[18px] text-center text-[14px] font-bold text-ink">
                          {item.qty}
                        </span>
                        <button
                          onClick={() => addOne(item)}
                          disabled={busy || cart.status !== "open"}
                          aria-label={t("grp.increase")}
                          className="tap-target flex size-7 items-center justify-center rounded-full text-cocoa transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-50"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    ) : (
                      // Somebody else's choice. Showing a stepper here would
                      // offer a control the server is right to refuse.
                      <span className="shrink-0 rounded-pill bg-beige/60 px-3 py-1.5 text-[13px] font-bold text-cocoa">
                        × {item.qty}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </FadeIn>
      )}

      {itemCount > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 mx-auto max-w-xl px-4 lg:static lg:mt-6 lg:px-0">
          {cart.isHost ? (
            <Link
              href={`/food/group/${id}/pay`}
              className="flex h-[58px] items-center gap-3 rounded-[22px] bg-accent px-4 text-white shadow-card transition-colors hover:bg-[#d4570f]"
            >
              <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15">
                <ShoppingBag size={17} />
                <span className="absolute -right-1 -top-1 flex min-w-[16px] items-center justify-center rounded-full bg-white px-1 text-[9px] font-bold text-accent">
                  {itemCount}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-white/85">
                  {t("grp.itemsAdded").replace("{n}", String(itemCount))}
                </span>
                <span className="block text-[14px] font-bold">{t("grp.proceedToPayment")}</span>
              </span>
              <span className="shrink-0 rounded-pill bg-white px-3.5 py-1.5 text-[15px] font-extrabold text-accent">
                {rupees(cart.totalPaise)}
              </span>
            </Link>
          ) : (
            // Only the host can place it, so a member is told where things
            // stand rather than shown a button that would be refused.
            <div className="rounded-[22px] bg-card p-3.5 text-center shadow-card">
              <p className="text-[13px] font-semibold text-ink">
                {t("grp.hostPays").replace("{amount}", rupees(cart.equalSplitPaise))}
              </p>
              <p className="mt-0.5 text-[12px] text-cocoa">{t("grp.hostPaysSub")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
