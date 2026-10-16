"use client";

// What chat did, shown under its reply: the cart as it now stands, a group
// order with its link and QR code, or a yes and no for something that waits
// for the customer. Everything here is read from the server's answer; nothing
// is worked out on the device.

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { Check, Copy, Share2, ShoppingCart, Users } from "lucide-react";
import { rupees } from "@/lib/money";
import { useI18n } from "@/components/i18n/I18nContext";
import type { ChatAction } from "./types";

export function ActionResult({ action, onReply, live }: { action: ChatAction; onReply: (text: string) => void; live: boolean }) {
  const card = action.card;
  if (!card) return null;
  if (card.type === "cart") return <CartCard cart={card.cart} />;
  if (card.type === "group") return <GroupCard group={card.group} joinPath={card.joinPath} />;
  if (card.type === "confirm" && live) return <ConfirmButtons onReply={onReply} />;
  return null;
}

function CartCard({ cart }: { cart: Extract<NonNullable<ChatAction["card"]>, { type: "cart" }>["cart"] }) {
  const { t } = useI18n();
  if (cart.count === 0) {
    return <p className="mt-2 text-[13px] text-cocoa">{t("ag.cartEmpty")}</p>;
  }
  const total = cart.lines.reduce((s, l) => s + l.pricePaise * l.qty, 0);
  return (
    <div className="mt-3 rounded-card border border-line bg-card p-3">
      <ul className="space-y-1.5">
        {cart.lines.map((l) => (
          <li key={`${l.dishId}@${l.platform}`} className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate text-ink">
              {l.name} <span className="text-cocoa">× {l.qty}</span>
            </span>
            <span className="shrink-0 text-cocoa">{rupees(l.pricePaise * l.qty)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-cocoa">{t("ag.estTotal").replace("{amount}", rupees(total))}</p>
      <Link
        href="/cart"
        className="tap-target mt-2.5 flex items-center justify-center gap-1.5 rounded-pill bg-accent px-4 py-2.5 text-[13px] font-semibold text-white"
      >
        <ShoppingCart size={14} />
        {t("ag.goToCart")}
      </Link>
    </div>
  );
}

function GroupCard({ group, joinPath }: { group: Extract<NonNullable<ChatAction["card"]>, { type: "group" }>["group"]; joinPath: string }) {
  const { t } = useI18n();
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? "" : `${window.location.origin}${joinPath}`;

  // Drawn on the device, like the group screen's own QR, so the join link is
  // never sent to a third party to render.
  useEffect(() => {
    if (!url) return;
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 360 })
      .then((d) => alive && setQr(d))
      .catch(() => alive && setQr(""));
    return () => {
      alive = false;
    };
  }, [url]);

  const joined = group.members.length;
  const joinedLabel = group.expectedMembers
    ? t("ag.joinedOf").replace("{n}", String(joined)).replace("{m}", String(group.expectedMembers))
    : t("ag.joined").replace("{n}", String(joined));

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked: the code and QR are still on screen.
    }
  }
  async function share() {
    try {
      await navigator.share({ url });
    } catch {
      await copy();
    }
  }

  return (
    <div className="mt-3 rounded-card border border-line bg-card p-3">
      <div className="flex items-center gap-2 text-[13px] text-ink">
        <Users size={15} className="text-accent" />
        <span className="font-semibold">{joinedLabel}</span>
        <span className="ml-auto rounded-pill bg-beige px-2.5 py-0.5 font-mono text-[12px] tracking-wider text-ink">{group.code}</span>
      </div>
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt={t("ag.qrAlt")} className="mx-auto mt-3 h-40 w-40 rounded-md bg-white p-1" />
      )}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <button type="button" onClick={copy} className="tap-target flex items-center justify-center gap-1 rounded-pill border border-line px-2 py-2 text-[12px] font-semibold text-ink">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t("ag.copied") : t("ag.copyLink")}
        </button>
        <button type="button" onClick={share} className="tap-target flex items-center justify-center gap-1 rounded-pill border border-line px-2 py-2 text-[12px] font-semibold text-ink">
          <Share2 size={13} />
          {t("ag.share")}
        </button>
        <Link href={`/food/group/${group.id}`} className="tap-target flex items-center justify-center rounded-pill bg-accent px-2 py-2 text-[12px] font-semibold text-white">
          {t("ag.openGroup")}
        </Link>
      </div>
    </div>
  );
}

function ConfirmButtons({ onReply }: { onReply: (text: string) => void }) {
  const { t } = useI18n();
  const [answered, setAnswered] = useState(false);
  const answer = (text: string) => {
    if (answered) return;
    setAnswered(true);
    onReply(text);
  };
  return (
    <div className="mt-3 flex gap-2">
      <button type="button" disabled={answered} onClick={() => answer("yes")} className="tap-target flex-1 rounded-pill bg-accent px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
        {t("ag.yes")}
      </button>
      <button type="button" disabled={answered} onClick={() => answer("no")} className="tap-target flex-1 rounded-pill border border-line px-4 py-2.5 text-[13px] font-semibold text-ink disabled:opacity-50">
        {t("ag.no")}
      </button>
    </div>
  );
}
