"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { Copy, Check, Link2, Share2, MessageCircle, Send, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { GroupHeader } from "@/components/food/GroupHeader";
import type { GroupCart } from "@/components/food/GroupCartTypes";
import { useI18n } from "@/components/i18n/I18nContext";
import { useToast } from "@/components/ui/Toast";
import { FadeIn } from "@/components/ui/motion";

// Figma "Create Group": the illustration and the sentence, then the two ways to
// hand the link over — a QR for someone in the room and a link for someone who
// is not — and a live count of who has actually arrived.
//
// The QR is rendered in the browser rather than fetched from a chart service,
// because sending a join link to a third party to be drawn is handing out an
// invitation to a private cart.

const POLL_MS = 4000;

export default function GroupInvitePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { t } = useI18n();
  const { toast } = useToast();
  const [cart, setCart] = useState<GroupCart | null>(null);
  const [qr, setQr] = useState<string>("");
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  const joinUrl =
    typeof window === "undefined" || !cart
      ? ""
      : `${window.location.origin}/food/group?code=${cart.code}`;

  const load = useCallback(() => {
    api<GroupCart>(`/api/groups/${id}`)
      .then(setCart)
      .catch(() => setCart(null));
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Drawn locally, in the brand's ink on the card colour.
  useEffect(() => {
    if (!joinUrl) return;
    let cancelled = false;
    QRCode.toDataURL(joinUrl, {
      width: 520,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#3d1c00ff", light: "#00000000" },
    })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setQr("");
      });
    return () => {
      cancelled = true;
    };
  }, [joinUrl]);

  async function copy(what: "link" | "code") {
    const text = what === "link" ? joinUrl : (cart?.code ?? "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      toast(t("grp.copyFailed"));
    }
  }

  // Native share where the phone offers it; the per-app buttons below are the
  // fallback for a desktop browser that has none.
  async function share() {
    const message = `${t("grp.shareMessage")} ${joinUrl}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: t("grp.shareTitle"), text: message, url: joinUrl });
        return;
      } catch {
        return; // dismissed
      }
    }
    void copy("link");
  }

  const joined = cart?.members.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-24 lg:max-w-2xl lg:px-6">
      <GroupHeader
        title={t("grp.createTitle")}
        backTo="/food/group"
        chatHref={`/food/group/${id}/chat`}
      />

      <FadeIn y={8}>
        <Card className="text-center">
          <span className="mx-auto flex size-20 items-center justify-center rounded-full bg-accent-soft">
            <Users size={34} className="text-accent" />
          </span>
          <p className="mx-auto mt-4 max-w-[16rem] text-[14px] leading-relaxed text-cocoa">
            {t("grp.createBlurb")}
          </p>
        </Card>
      </FadeIn>

      {/* QR — for the friend sitting across the table */}
      <Card className="mt-4 flex flex-col items-center py-6">
        {qr ? (
          // A data: URI drawn in this browser — next/image cannot optimise
          // one, and routing it through the optimiser would add a round trip
          // for bytes we already hold.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt={t("grp.qrAlt")}
            className="size-52 max-w-full"
            width={208}
            height={208}
          />
        ) : (
          <div className="flex size-52 items-center justify-center rounded-[18px] bg-beige/50 text-[12px] text-cocoa">
            {t("common.loading")}
          </div>
        )}
        <button
          onClick={() => copy("code")}
          className="tap-target mt-4 rounded-pill border border-dashed border-accent/50 px-4 py-1.5 font-mono text-[15px] font-bold tracking-[0.2em] text-accent"
        >
          {cart?.code ?? "······"}
        </button>
        <p className="mt-1.5 text-[11px] text-cocoa">
          {copied === "code" ? t("grp.codeCopied") : t("grp.orShareCode")}
        </p>
      </Card>

      {/* Link + copy */}
      <div className="mt-4 flex items-center gap-2 rounded-[18px] bg-card px-3.5 py-2.5 shadow-soft">
        <Link2 size={16} className="shrink-0 text-cocoa" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-cocoa">
          {joinUrl || "…"}
        </span>
        <button
          onClick={() => copy("link")}
          disabled={!joinUrl}
          className="tap-target flex shrink-0 items-center gap-1.5 rounded-pill bg-ink-fill px-3.5 py-1.5 text-[12px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {copied === "link" ? <Check size={13} /> : <Copy size={13} />}
          {copied === "link" ? t("grp.copied") : t("grp.copyLink")}
        </button>
      </div>

      <p className="mt-5 text-[12px] font-semibold text-cocoa">{t("grp.shareVia")}</p>
      <div className="mt-2.5 grid grid-cols-4 gap-2.5">
        <ShareTile
          label="WhatsApp"
          tint="bg-[#25d366]/12 text-[#1da851]"
          icon={<MessageCircle size={19} />}
          href={joinUrl ? `https://wa.me/?text=${encodeURIComponent(`${t("grp.shareMessage")} ${joinUrl}`)}` : undefined}
        />
        <ShareTile
          label="Telegram"
          tint="bg-[#2aabee]/12 text-[#1d8fca]"
          icon={<Send size={18} />}
          href={joinUrl ? `https://t.me/share/url?url=${encodeURIComponent(joinUrl)}&text=${encodeURIComponent(t("grp.shareMessage"))}` : undefined}
        />
        <ShareTile
          label="SMS"
          tint="bg-accent-soft text-accent-ink"
          icon={<MessageCircle size={18} />}
          href={joinUrl ? `sms:?body=${encodeURIComponent(`${t("grp.shareMessage")} ${joinUrl}`)}` : undefined}
        />
        <ShareTile
          label={t("grp.more")}
          tint="bg-beige text-cocoa"
          icon={<Share2 size={18} />}
          onClick={share}
        />
      </div>

      {/* Who has arrived. The design's "1 / 5 Joined" counts people, and a group
          has no fixed size here, so it counts what is true instead. */}
      <div className="fixed inset-x-0 bottom-16 z-20 mx-auto max-w-xl px-4 lg:static lg:mt-6 lg:px-0">
        <div className="rounded-[22px] bg-card p-3 shadow-card lg:shadow-soft">
          <p className="text-center text-[13px] font-semibold text-cocoa">
            {joined === 1
              ? t("grp.waitingForFriends")
              : t("grp.joinedCount").replace("{n}", String(joined))}
          </p>
          <Button
            onClick={() => router.push(`/food/group/${id}`)}
            className="mt-2.5 h-[52px] w-full rounded-[20px] text-[15px]"
          >
            {t("grp.continueToGroup")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShareTile({
  label,
  icon,
  tint,
  href,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  tint: string;
  href?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={`flex size-11 items-center justify-center rounded-full ${tint}`}>
        {icon}
      </span>
      <span className="mt-1.5 block truncate text-[11px] font-medium text-cocoa">
        {label}
      </span>
    </>
  );
  const cls =
    "tap-target flex flex-col items-center rounded-[16px] py-1 transition-colors hover:bg-beige/40";
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      {body}
    </a>
  ) : (
    <button onClick={onClick} className={cls}>
      {body}
    </button>
  );
}
