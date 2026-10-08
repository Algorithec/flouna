"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { PriceAlertListener } from "@/components/alerts/PriceAlertListener";
import { useAuth } from "@/components/auth/AuthContext";
import { AppLock } from "@/components/security/AppLock";
import { registerDeviceQuietly } from "@/lib/groupChatSetup";
import { Ghost } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  TemporaryChatProvider,
  useTemporaryChat,
} from "@/components/chat/TemporaryChatContext";

// Layout for all signed-in screens: persistent sidebar on desktop, hamburger
// drawer on mobile — one codebase, two views. The drawer is the single
// navigation surface (no bottom tab bar), matching the design.
//
// The mobile bar follows Figma 2177:4763: hamburger left, wordmark centred,
// avatar right. The wordmark is centred against the viewport rather than laid
// out between the two controls, so it stays optically centred even when a
// screen passes a title through.
export function AppShell({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user } = useAuth();

  // Publish this browser's chat keys as soon as somebody is signed in.
  //
  // A sender key distribution message carries the sender's chain at its current
  // position, so a device only becomes readable-to from the moment it is known.
  // Registering here rather than when a chat is opened is what stops a member
  // finding everything said before they tapped through permanently locked.
  useEffect(() => {
    if (!user) return;
    void registerDeviceQuietly();
  }, [user]);
  const pathname = usePathname();

  // The account screens are drawn on their own near-white grey rather than the
  // app cream. The sticky header sits directly above them, so it has to take
  // the same ground or a hard colour seam shows across the top of the page.
  const onAccountGround = pathname.startsWith("/profile");
  // The conversation screen. Its header carries the incognito switch instead of
  // the avatar: the profile is already one tap away in the sidebar, and a
  // second way to reach it costs the only slot a private-mode control could
  // have.
  const onChat = pathname === "/home";

  // Every profile screen draws its own back-arrow title — Settings,
  // Details, Privacy, all of them, same as View Profile. Confirmed against
  // both; the rest share the identical header component (SubPage) or the
  // same hand-built row, so the generic hamburger bar stacking above it is
  // the same redundant double-header everywhere in this family, not just
  // the one screen that happened to get checked first.
  //
  // Booking History, Need Help and the complaint tracker draw the same
  // centred back-arrow header, so they belong to that family too.
  const ownsHeader =
    onAccountGround ||
    pathname === "/history" ||
    pathname.startsWith("/complaints/") ||
    /^\/orders\/[^/]+\/help$/.test(pathname);
  const hideHeader = ownsHeader;

  return (
    // Biometric Lock wraps the whole signed-in shell: when this device has a
    // platform credential registered and the last unlock has expired, nothing
    // behind it renders until the person passes their fingerprint or face.
    <AppLock>
    {/* The incognito switch lives in the header and the state it controls lives
        in the conversation below it, so the provider has to sit above both. */}
    <TemporaryChatProvider>
    <div className="flex min-h-dvh w-full">
      <PriceAlertListener />
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        {!hideHeader && (
          <header
            className={`sticky top-0 z-20 flex h-16 items-center justify-between gap-3 px-4 backdrop-blur lg:hidden ${
              // Near-opaque: at 90% the chat's own chips read straight through
              // the bar as it scrolls under, which looks like a layering fault
              // rather than a frosted header.
              onAccountGround ? "bg-acct-bg/97" : "bg-cream/97"
            }`}
          >
            <button
              onClick={() => setSidebarOpen(true)}
              className="tap-target -ml-1 rounded-full p-2 text-ink transition-colors hover:bg-beige"
              aria-label={t("as.openMenu")}
            >
              <Menu size={24} />
            </button>

            <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[19px] font-bold text-ink">
              {title ?? "Flouna"}
            </span>

            {onChat ? (
              <IncognitoToggle />
            ) : user ? (
              <Link
                href="/profile"
                aria-label={t("as.profile")}
                className="tap-target flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-soft text-[14px] font-bold text-accent"
              >
                {user.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.avatarUrl} alt="" className="size-full object-cover" />
                ) : (
                  (user.name?.trim()?.[0] ?? "?").toUpperCase()
                )}
              </Link>
            ) : (
              // Figma's signed-out header swaps the avatar for a Login pill —
              // not reachable while (app) sits behind RequireAuth, but this
              // component doesn't own that gate, so it stays correct for
              // whenever it does allow an anonymous visitor through.
              <Link
                href="/login"
                className="shrink-0 rounded-pill bg-card px-4 py-1.5 text-[13px] font-bold text-ink shadow-soft transition-colors hover:bg-beige/40"
              >
                {t("as.login")}
              </Link>
            )}
          </header>
        )}

        <main className="flex-1 pb-6">{children}</main>
      </div>
    </div>
    </TemporaryChatProvider>
    </AppLock>
  );
}

/**
 * The incognito switch, in the header slot the avatar used to hold.
 *
 * On means nothing about this conversation is stored: it does not appear in
 * recent chats and it never feeds the personalisation that reads chat history.
 * The state has to be legible at a glance, so on is a filled accent circle
 * rather than the same grey icon with a different tooltip.
 */
function IncognitoToggle() {
  const { t } = useI18n();
  const { temporary, toggle } = useTemporaryChat();
  return (
    <button
      onClick={toggle}
      aria-pressed={temporary}
      aria-label={
        temporary
          ? t("as.tempOnTitle")
          : t("as.tempOffTitle")
      }
      title={
        temporary
          ? t("as.tempOnLabel")
          : t("as.tempOffLabel")
      }
      className={cn(
        "tap-target flex size-10 shrink-0 items-center justify-center rounded-full transition-colors",
        temporary
          ? "bg-accent text-white"
          : "bg-card text-cocoa shadow-soft hover:bg-beige/60",
      )}
    >
      <Ghost size={19} />
    </button>
  );
}
