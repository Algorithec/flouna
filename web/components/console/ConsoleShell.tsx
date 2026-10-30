"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Menu,
  Flag,
  ScrollText,
  Users,
  ShieldCheck,
  LogOut,
  LayoutDashboard,
  Receipt,
  LifeBuoy,
  Scale,
  Settings,
  MapPin,
  Store,
  Brain,
  Tags,
  TrendingDown,
  Network,
  Bell,
  KeyRound,
  Coins,
  ChartBar,
  TrendingUp,
  RotateCcw,
  Megaphone,
  type LucideIcon,
  ShieldAlert,
  Gavel,
  Landmark,
  Cpu,
} from "lucide-react";
import { api } from "@/lib/api";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { roleSatisfies, type Operator, type Role } from "./useOperator";

type NavItem = { href: string; label: string; icon: LucideIcon; need: Role };
type NavSection = { section: string; items: NavItem[] };

// Grouped nav (mirrors the founder's layout: Overview / Commerce / Intelligence
// / System). Each item declares the minimum role it needs; we render only what
// the current operator can use. The server still enforces access on every call.
const NAV: NavSection[] = [
  {
    section: "Overview",
    items: [
      { href: "/console/admin", label: "Dashboard", icon: LayoutDashboard, need: "admin" },
      { href: "/console/admin/analytics", label: "Analytics", icon: ChartBar, need: "admin" },
      { href: "/console/super/growth", label: "Growth", icon: TrendingUp, need: "super_admin" },
      { href: "/console/admin/cities", label: "City report", icon: MapPin, need: "admin" },
      { href: "/console/dev", label: "Diagnostics", icon: Activity, need: "developer" },
    ],
  },
  {
    section: "Commerce",
    items: [
      { href: "/console/admin/orders", label: "Orders", icon: Receipt, need: "admin" },
      { href: "/console/admin/ondc-money", label: "ONDC money", icon: Landmark, need: "admin" },
      { href: "/console/admin/vendors", label: "Vendors / MSMEs", icon: Store, need: "admin" },
      { href: "/console/super", label: "Revenue & commissions", icon: Coins, need: "super_admin" },
      { href: "/console/super/refunds", label: "Refunds", icon: RotateCcw, need: "super_admin" },
      { href: "/console/dev/network", label: "ONDC operations", icon: Network, need: "developer" },
      { href: "/console/dev/transactions", label: "ONDC transactions", icon: ScrollText, need: "developer" },
    ],
  },
  {
    section: "Intelligence",
    items: [
      { href: "/console/admin/decisions", label: "Decision logs", icon: Brain, need: "admin" },
      { href: "/console/dev/model", label: "Model operations", icon: Cpu, need: "developer" },
      { href: "/console/admin/coupons", label: "Coupon engine", icon: Tags, need: "admin" },
      { href: "/console/admin/price-alerts", label: "Price alerts", icon: TrendingDown, need: "admin" },
    ],
  },
  {
    section: "System",
    items: [
      { href: "/console/admin/users", label: "Users", icon: Users, need: "admin" },
      { href: "/console/admin/support", label: "Support", icon: LifeBuoy, need: "admin" },
      // Two entries rather than one, because they answer different questions.
      // ONDC complaints is the protocol log; Grievances is the four deadlines
      // we published to the customer, which is what somebody chasing a case
      // is actually asking about.
      { href: "/console/admin/grievances", label: "Grievances", icon: ShieldAlert, need: "admin" },
      { href: "/console/admin/appeals", label: "Decision appeals", icon: Gavel, need: "admin" },
      { href: "/console/admin/complaints", label: "ONDC complaints", icon: Scale, need: "admin" },
      { href: "/console/super/staff", label: "Staff & roles", icon: ShieldCheck, need: "super_admin" },
      { href: "/console/super/broadcast", label: "Broadcast", icon: Megaphone, need: "super_admin" },
      { href: "/console/super/api-keys", label: "API keys", icon: KeyRound, need: "super_admin" },
      { href: "/console/dev/errors", label: "Errors", icon: AlertTriangle, need: "developer" },
      { href: "/console/dev/alerts", label: "Alerts", icon: Bell, need: "developer" },
      { href: "/console/dev/flags", label: "Feature flags", icon: Flag, need: "developer" },
      { href: "/console/super/audit", label: "Audit trail", icon: ScrollText, need: "super_admin" },
      { href: "/console/super/config", label: "Settings", icon: Settings, need: "super_admin" },
    ],
  },
];

// Index routes that must match exactly (deeper routes light up on children).
const EXACT = new Set(["/console/dev", "/console/admin", "/console/super"]);

const ROLE_LABEL: Record<Role, string> = {
  user: "User",
  developer: "Developer",
  admin: "Admin",
  super_admin: "Super-admin",
};

export function ConsoleShell({
  operator,
  children,
}: {
  operator: Operator;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // The sidebar is a fixed 224px column. On a phone that left roughly 100px
  // for the page itself, which shredded every stat card and table on the
  // console. Below lg it becomes a drawer instead.
  const [navOpen, setNavOpen] = useState(false);
  // The drawer is a dialog over the page, and every other sheet in the product
  // closes on Escape. This one did not, so a keyboard user who opened the
  // console nav on a narrow window could only leave it by tabbing past
  // twenty-odd links to the scrim.
  useEscapeToClose(navOpen, () => setNavOpen(false));

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/console/login");
  }

  // Keep only sections that have at least one item this operator may use.
  const sections = NAV.map((s) => ({
    section: s.section,
    items: s.items.filter((n) => roleSatisfies(operator.role, n.need)),
  })).filter((s) => s.items.length > 0);

  const isActive = (href: string) =>
    pathname === href || (!EXACT.has(href) && pathname.startsWith(`${href}/`));

  return (
    <div className="flex min-h-dvh">
      {/* Scrim behind the drawer on small screens. */}
      {navOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 lg:hidden print:hidden"
        />
      )}
      <aside
        // `max-lg:invisible` while closed, not only translated away. Off-screen
        // is still in the tab order, so on a narrow window a keyboard user
        // leaving the hamburger walked into twenty-odd links they could not
        // see. Visibility is in the transition so the slide-out still plays.
        className={`fixed inset-y-0 left-0 z-40 flex w-56 shrink-0 flex-col text-white transition-[transform,visibility] lg:visible lg:static lg:translate-x-0 print:hidden ${
          navOpen ? "translate-x-0" : "invisible -translate-x-full"
        }`}
        style={{ background: "var(--c-crimson)" }}
      >
        <div
          className="flex flex-col px-5 py-5"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.12)" }}
        >
          <span className="c-serif text-[17px] font-extrabold tracking-tight text-white">
            Algorithec
          </span>
          <span
            className="c-label mt-0.5 text-[10px]"
            style={{ color: "var(--c-amber)" }}
          >
            Console · v1.0
          </span>
        </div>
        <nav className="flex-1 space-y-3 overflow-y-auto px-3 pb-4 pt-3">
          {sections.map((s) => (
            <div key={s.section}>
              <p className="c-label px-3 pb-1 pt-1 text-[10px] text-white/45">
                {s.section}
              </p>
              {s.items.map((n) => {
                const active = isActive(n.href);
                const Icon = n.icon;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    onClick={() => setNavOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors"
                    style={
                      active
                        ? { background: "var(--c-maroon)", color: "#fff" }
                        : { color: "rgba(255,255,255,0.72)" }
                    }
                  >
                    <Icon
                      size={16}
                      style={{ color: active ? "var(--c-amber)" : "rgba(255,255,255,0.55)" }}
                    />
                    {n.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div
          className="px-4 py-4"
          style={{ borderTop: "1px solid rgba(255,255,255,0.12)" }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
              style={{ background: "var(--c-amber)", color: "var(--c-crimson)" }}
            >
              {operator.name.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-medium text-white">
                {operator.name}
              </p>
              <p className="truncate text-[10.5px]" style={{ color: "var(--c-amber)" }}>
                {ROLE_LABEL[operator.role]}
              </p>
            </div>
          </div>
          <button
            onClick={signOut}
            className="mt-3 flex items-center gap-1.5 text-[12px] text-white/55 hover:text-white"
          >
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header: the only way to reach the nav once it's a drawer. */}
        <header
          className="flex items-center gap-3 px-4 py-3 text-white lg:hidden print:hidden"
          style={{ background: "var(--c-crimson)" }}
        >
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            aria-expanded={navOpen}
            className="tap-target rounded-lg p-1.5 transition-colors hover:bg-white/10"
          >
            <Menu size={20} />
          </button>
          <span className="c-serif text-[15px] font-extrabold tracking-tight">
            Algorithec
          </span>
          <span className="ml-auto text-[11px] uppercase tracking-[0.14em] text-white/60">
            Console
          </span>
        </header>
        {/* Printed as a report: the page alone, without the console around it, and
            not cut off at the window's height. */}
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8 lg:py-7 print:overflow-visible print:p-0">
          {children}
        </main>
      </div>
    </div>
  );
}

// Small primitives used across console pages.
export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="c-serif text-2xl font-extrabold" style={{ color: "var(--c-maroon)" }}>
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1 text-[13px]" style={{ color: "var(--c-muted)" }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const accent = {
    default: "var(--c-maroon)",
    good: "#1a7a4a",
    warn: "var(--c-amber)",
    bad: "var(--c-red)",
  }[tone];
  return (
    <div
      className="relative overflow-hidden rounded-xl bg-white p-4"
      style={{ border: "1px solid var(--c-border)" }}
    >
      <span
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: accent }}
      />
      <p className="c-label text-[10.5px]" style={{ color: "var(--c-muted)" }}>
        {label}
      </p>
      <p
        className="c-serif mt-1.5 text-[26px] font-extrabold leading-none"
        style={{ color: tone === "default" ? "var(--c-ink)" : accent }}
      >
        {value}
      </p>
      {hint && (
        <p className="mt-1.5 text-[11px]" style={{ color: "var(--c-muted)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}
