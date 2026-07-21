"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Home,
  History,
  Pizza,
  Car,
  Settings,
  PenLine,
  PanelLeft,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";

type ChatSessionSummary = { id: string; title: string | null };

// Figma desktop sidebar: New chat / Home / History / Food / Rides with a
// gear+Profile row pinned to the bottom. On desktop it collapses to an
// icon-only rail (the PanelLeft toggle), remembered across visits. On mobile
// it stays the full-width drawer.
const navItems: { href: string; key: TranslationKey; icon: typeof Home }[] = [
  { href: "/home", key: "nav.home", icon: Home },
  { href: "/history", key: "nav.history", icon: History },
  { href: "/food", key: "nav.food", icon: Pizza },
  { href: "/rides", key: "nav.rides", icon: Car },
];

const COLLAPSE_KEY = "radiues-sidebar-collapsed";
const COLLAPSE_EVENT = "radiues-sidebar-collapse";

function subscribeCollapse(cb: () => void) {
  window.addEventListener(COLLAPSE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(COLLAPSE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const [recent, setRecent] = useState<ChatSessionSummary[]>([]);
  const [showAll, setShowAll] = useState(false);
  // Collapse preference lives in localStorage (SSR renders expanded).
  const collapsed = useSyncExternalStore(
    subscribeCollapse,
    () => localStorage.getItem(COLLAPSE_KEY) === "1",
    () => false,
  );

  function toggleCollapsed() {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "0" : "1");
    window.dispatchEvent(new Event(COLLAPSE_EVENT));
  }

  // Refresh the list whenever navigation happens (a new chat updates the URL).
  useEffect(() => {
    api<{ sessions: ChatSessionSummary[] }>("/api/chat/sessions")
      .then((d) => setRecent(d.sessions))
      .catch(() => setRecent([]));
  }, [pathname, searchParams]);

  const visible = showAll ? recent : recent.slice(0, 5);

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink/30 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col bg-card px-4 py-5 transition-transform",
          "lg:static lg:translate-x-0 lg:shrink-0 lg:border-r lg:border-line lg:bg-cream lg:transition-[width] lg:duration-200",
          collapsed ? "lg:w-[88px] lg:px-3" : "lg:w-[264px]",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div
          className={cn(
            "flex items-center",
            collapsed ? "lg:flex-col lg:gap-4" : "justify-between",
          )}
        >
          <Link href="/home" aria-label="Radiues home" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="" className="size-9 rounded-[10px]" />
            <span
              className={cn(
                "text-[20px] font-bold text-ink",
                collapsed && "lg:hidden",
              )}
            >
              Radiues
            </span>
          </Link>
          <button
            onClick={toggleCollapsed}
            className="hidden rounded-[10px] p-2 text-cocoa transition-colors hover:bg-beige lg:block"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft size={20} />
          </button>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-cocoa hover:bg-beige lg:hidden"
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        <nav className={cn("mt-8 flex flex-col gap-2", collapsed && "lg:items-center")}>
          <Link
            href="/home"
            onClick={onClose}
            title={t("nav.newChat")}
            className={cn(
              "flex items-center gap-3 rounded-pill px-4 py-3 text-[15px] font-medium text-ink/85 transition-colors hover:bg-beige/70",
              collapsed && "lg:justify-center lg:px-3",
            )}
          >
            <PenLine size={19} className="shrink-0 text-ink" />
            <span className={cn(collapsed && "lg:hidden")}>{t("nav.newChat")}</span>
          </Link>

          {navItems.map(({ href, key, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                title={t(key)}
                className={cn(
                  "flex items-center gap-3 rounded-pill px-4 py-3 text-[15px] transition-colors",
                  active
                    ? "bg-accent-soft font-semibold text-accent"
                    : "text-ink/85 hover:bg-beige/70",
                  collapsed && "lg:justify-center lg:px-3",
                )}
              >
                <Icon
                  size={19}
                  className={cn("shrink-0", active ? "text-accent" : "text-cocoa")}
                />
                <span className={cn(collapsed && "lg:hidden")}>{t(key)}</span>
              </Link>
            );
          })}
        </nav>

        {/* Recent chats — expanded sidebar and mobile drawer only */}
        <div
          className={cn(
            "mt-7 min-h-0 flex-1 overflow-y-auto",
            collapsed && "lg:invisible",
          )}
        >
          <p className="px-3 text-[12px] font-semibold text-accent">
            Recent Chats
          </p>
          <div className="mt-2 flex flex-col gap-0.5">
            {recent.length === 0 && (
              <p className="flex items-center gap-2 px-3 py-2 text-[13px] text-cocoa/70">
                <PenLine size={14} />
                No chats yet
              </p>
            )}
            {visible.map((s) => (
              <Link
                key={s.id}
                href={`/home?chat=${s.id}`}
                onClick={onClose}
                className="flex items-center gap-2 truncate rounded-[10px] px-3 py-2 text-[13px] text-ink/80 transition-colors hover:bg-beige/60"
              >
                <PenLine size={13} className="shrink-0 text-cocoa/60" />
                <span className="truncate">{s.title ?? "New chat"}</span>
              </Link>
            ))}
            {recent.length > 5 && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                className="px-3 py-2 text-left text-[13px] font-semibold text-accent hover:underline"
              >
                Show all
              </button>
            )}
          </div>
        </div>

        {/* Bottom pinned: gear + Profile, per the desktop design */}
        <Link
          href="/profile"
          onClick={onClose}
          title={t("nav.profile")}
          className={cn(
            "mt-4 flex items-center gap-3 rounded-pill px-4 py-3 text-[15px] font-semibold text-ink transition-colors hover:bg-beige/70",
            collapsed && "lg:justify-center lg:px-3",
          )}
        >
          <Settings size={19} className="shrink-0 text-ink" />
          <span className={cn(collapsed && "lg:hidden")}>{t("nav.profile")}</span>
        </Link>
      </aside>
    </>
  );
}
