"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { ArrowLeft, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useBackTo } from "@/lib/navHistory";
import { cn } from "@/lib/cn";

// The header every group screen shares: back on the left, the title centred,
// and — where there is a conversation to go to — the chat on the right.
//
// One component rather than six copies, because the design's balance depends on
// the left and right slots being the same width. Hand-rolling that per screen is
// how a centred title quietly stops being centred.
export function GroupHeader({
  title,
  subtitle,
  backTo,
  chatHref,
  unread,
  right,
}: {
  title: string;
  subtitle?: string;
  backTo: string;
  chatHref?: string;
  unread?: number;
  right?: React.ReactNode;
}) {
  const { t } = useI18n();
  const goBack = useBackTo(backTo);
  return (
    <div className="flex items-start gap-2 py-4">
      <button
        onClick={goBack}
        aria-label={t("au.back")}
        className="tap-target mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-beige/60"
      >
        <ArrowLeft size={18} className="text-ink" />
      </button>
      <div className="min-w-0 flex-1 text-center">
        <h1 className="truncate text-[17px] font-extrabold text-ink">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 truncate text-[12px] text-cocoa">{subtitle}</p>
        )}
      </div>
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center">
        {right ??
          (chatHref ? (
            <Link
              href={chatHref}
              aria-label={t("chat.groupChat")}
              className={cn(
                "tap-target relative flex size-9 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-beige/60",
              )}
            >
              <MessageCircle size={17} className="text-ink" />
              {unread ? (
                <span className="absolute -right-0.5 -top-0.5 flex min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
                  {unread > 9 ? "9+" : unread}
                </span>
              ) : null}
            </Link>
          ) : null)}
      </div>
    </div>
  );
}

/** The overlapping member avatars the design puts above the menu. */
export function MemberStrip({
  members,
  max = 5,
}: {
  members: { userId: string; name: string; isYou: boolean }[];
  max?: number;
}) {
  const shown = members.slice(0, max);
  const extra = members.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((m, i) => (
        <span
          key={m.userId}
          title={m.name}
          style={{ marginLeft: i === 0 ? 0 : -10, zIndex: shown.length - i }}
          className="flex size-9 items-center justify-center rounded-full border-2 border-cream bg-accent-soft text-[13px] font-bold text-accent-ink"
        >
          {m.name.trim().charAt(0).toUpperCase() || "?"}
        </span>
      ))}
      {extra > 0 && (
        <span
          style={{ marginLeft: -10 }}
          className="flex size-9 items-center justify-center rounded-full border-2 border-cream bg-beige text-[11px] font-bold text-cocoa"
        >
          +{extra}
        </span>
      )}
    </div>
  );
}
