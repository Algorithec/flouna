"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BellRing,
  Check,
  Clock,
  Pencil,
  UserPlus,
  Utensils,
  Bookmark,
  ShoppingBag,
} from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { GroupHeader } from "@/components/food/GroupHeader";
import type { GroupCart } from "@/components/food/GroupCartTypes";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { cn } from "@/lib/cn";
import { joinChatQuietly } from "@/lib/groupChatSetup";

// Figma "Group Status": the named group, then every member with where they have
// got to, then the one action the host has while waiting.
//
// Joined and ordered are two different things and the design shows both, so
// this screen never says "Joined" about someone who is still reading the menu.

const POLL_MS = 4000;

export default function GroupStatusPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { t } = useI18n();
  const { toast } = useToast();
  const [cart, setCart] = useState<GroupCart | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<GroupCart>(`/api/groups/${id}`)
      .then((c) => {
        setCart(c);
        // A cart that has been ordered has a tracking screen; sitting on the
        // member list after checkout is a dead end.
        if (c.status === "ordered" && c.orderId) router.replace(`/orders/${c.orderId}`);
      })
      .catch((e) => setError(e instanceof Error ? e.message : t("grp.loadFailed")));
  }, [id, router, t]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Publish this device's chat keys on arrival, not when the chat is first
  // opened. A distribution message carries the chain's current position, so a
  // device that appears after a message was sent can never read that message —
  // being in the room is what has to register you, exactly as being in a
  // WhatsApp group registers your phone whether the thread is open or not.
  useEffect(() => {
    void joinChatQuietly(id);
  }, [id]);

  async function rename() {
    const name = draftName.trim();
    if (!name) return;
    setBusy(true);
    try {
      setCart(
        await api<GroupCart>(`/api/groups/${id}`, {
          method: "PATCH",
          json: { name },
        }),
      );
      setRenaming(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : t("grp.renameFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remind() {
    setBusy(true);
    try {
      const d = await api<{ reminded: number }>(`/api/groups/${id}/remind`, {
        method: "POST",
        json: {},
      });
      toast(
        d.reminded === 0
          ? t("grp.everyoneOrdered")
          : t("grp.remindedCount").replace("{n}", String(d.reminded)),
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : t("grp.remindFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveCrew() {
    const name = (cart?.name ?? "").trim() || t("grp.defaultCrewName");
    setBusy(true);
    try {
      await api(`/api/groups/crews`, {
        method: "POST",
        json: { cartId: id, name, emoji: cart?.emoji ?? undefined },
      });
      toast(t("grp.crewSaved").replace("{name}", name));
    } catch (e) {
      toast(e instanceof Error ? e.message : t("grp.crewSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <p className="text-[14px] text-danger">{error}</p>
      </div>
    );
  }
  if (!cart) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <p className="text-[13px] text-cocoa">{t("common.loading")}</p>
      </div>
    );
  }

  const title = `${cart.emoji ?? ""} ${cart.name ?? t("grp.untitled")}`.trim();
  const ordered = cart.members.filter((m) => m.hasOrdered).length;
  const waiting = cart.members.length - ordered;

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-28 lg:max-w-2xl lg:px-6 lg:pb-10">
      <GroupHeader
        title={t("grp.statusTitle")}
        backTo="/food/group"
        chatHref={`/food/group/${id}/chat`}
      />

      {/* The group itself */}
      <FadeIn y={8}>
        <Card className="py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[20px]">
              {cart.emoji ?? <Utensils size={19} className="text-accent" />}
            </span>
            <div className="min-w-0 flex-1">
              {renaming ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value.slice(0, 40))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename();
                      if (e.key === "Escape") setRenaming(false);
                    }}
                    placeholder={t("grp.namePlaceholder")}
                    className="min-w-0 flex-1 rounded-pill border border-line bg-cream px-3 py-1.5 text-[14px] text-ink outline-none focus:border-accent"
                  />
                  <button
                    onClick={rename}
                    disabled={busy}
                    className="tap-target shrink-0 rounded-pill bg-accent px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-60"
                  >
                    {t("common.save")}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 truncate text-[16px] font-extrabold text-ink">
                    {title}
                  </p>
                  {cart.isHost && (
                    <button
                      onClick={() => {
                        setDraftName(cart.name ?? "");
                        setRenaming(true);
                      }}
                      aria-label={t("grp.rename")}
                      className="tap-target shrink-0 rounded-full p-1 text-cocoa hover:bg-beige/50"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                </div>
              )}
              <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-success">
                <span className="size-1.5 rounded-full bg-success" />
                {t("grp.orderedOfJoined")
                  .replace("{a}", String(ordered))
                  .replace("{b}", String(cart.members.length))}
              </p>
            </div>
            <Link
              href={`/food/group/${id}/invite`}
              aria-label={t("grp.inviteMore")}
              className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-beige/60 text-cocoa transition-colors hover:bg-beige"
            >
              <UserPlus size={17} />
            </Link>
          </div>
        </Card>
      </FadeIn>

      {/* Members */}
      <div className="mt-5 flex items-center gap-2">
        <h2 className="text-[15px] font-extrabold text-ink">{t("grp.members")}</h2>
        <span className="rounded-pill bg-beige/70 px-2 py-0.5 text-[11px] font-semibold text-cocoa">
          {cart.members.length}
        </span>
      </div>

      <Stagger className="mt-3 overflow-hidden rounded-[18px] bg-card shadow-soft">
        {cart.members.map((m, i) => (
          <StaggerItem key={m.userId}>
            <div
              className={cn(
                "flex items-center gap-3 px-4 py-3.5",
                i < cart.members.length - 1 && "border-b border-line",
              )}
            >
              <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[15px] font-bold text-accent-ink">
                {m.name.trim().charAt(0).toUpperCase() || "?"}
                {m.active && (
                  <span className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-card bg-success" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold text-ink">
                  {m.isYou ? t("grp.you").replace("{name}", m.name) : m.name}
                </span>
                {m.hasOrdered && (
                  <span className="block text-[12px] text-cocoa">
                    {rupees(m.subtotalPaise)}
                  </span>
                )}
              </span>
              {m.isHost && (
                <span className="shrink-0 rounded-pill bg-accent-soft px-2.5 py-1 text-[11px] font-bold text-accent-ink">
                  {t("grp.admin")}
                </span>
              )}
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-pill px-2.5 py-1 text-[11px] font-semibold",
                  m.hasOrdered
                    ? "bg-success/10 text-success"
                    : "bg-warning/10 text-warning",
                )}
              >
                {m.hasOrdered ? <Check size={12} /> : <Clock size={12} />}
                {m.hasOrdered ? t("grp.ordered") : t("grp.waiting")}
              </span>
            </div>
          </StaggerItem>
        ))}
      </Stagger>

      {cart.isHost && (
        <div className="mt-4 flex flex-col gap-2.5">
          <button
            onClick={remind}
            disabled={busy || waiting === 0}
            className="tap-target flex h-[52px] w-full items-center justify-center gap-2 rounded-pill border border-accent/40 bg-card text-[15px] font-bold text-accent transition-colors hover:bg-accent-soft disabled:opacity-45"
          >
            <BellRing size={17} />
            {waiting === 0 ? t("grp.everyoneOrdered") : t("grp.remindFriends")}
          </button>
          <button
            onClick={saveCrew}
            disabled={busy}
            className="tap-target flex h-[48px] w-full items-center justify-center gap-2 rounded-pill border border-line bg-card text-[14px] font-semibold text-cocoa transition-colors hover:bg-beige/40 disabled:opacity-50"
          >
            <Bookmark size={16} />
            {t("grp.saveCrew")}
          </button>
        </div>
      )}

      {/* Sticky action */}
      <div className="fixed inset-x-0 bottom-16 z-20 mx-auto max-w-xl px-4 lg:static lg:mt-6 lg:px-0">
        <div className="flex gap-2.5">
          <Link
            href={`/food/group/${id}/menu`}
            className="flex h-[56px] flex-1 items-center justify-center gap-2 rounded-[22px] bg-accent text-[15px] font-semibold text-white shadow-card transition-colors hover:bg-[#d4570f]"
          >
            <Utensils size={17} /> {t("grp.openMenu")}
          </Link>
          {cart.items.length > 0 && (
            <Link
              href={`/food/group/${id}/cart`}
              aria-label={t("grp.viewCart")}
              className="flex h-[56px] w-[56px] shrink-0 items-center justify-center rounded-[22px] bg-card text-ink shadow-card transition-colors hover:bg-beige/50"
            >
              <ShoppingBag size={19} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
