"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useBackTo } from "@/lib/navHistory";
import { api } from "@/lib/api";
import {
  UserRound,
  ShieldCheck,
  Bell,
  CreditCard,
  Tag,
  Receipt,
  LifeBuoy,
  MessageCircle,
  ChevronRight,
  Mail,
  Phone,
  MapPin,
  LogOut,
  Camera,
  ArrowLeft,
  Moon,
  Sun,
  type LucideIcon,
  DatabaseZap,
  ShieldAlert,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthContext";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { useTheme } from "@/components/theme/ThemeContext";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";

// Figma "View Profile" (2195:589): avatar with an edit badge, name, a premium
// pill, a three-column identity strip, then Account and Support lists whose
// rows carry an icon badge, a title and a line of explanatory copy.
//
// The copy below is the design's own. It's deliberately not run through i18n
// yet: these strings don't exist in the dictionaries, and inventing six
// languages' worth of row subtitles here would be guessing. The existing
// translated labels stay on the screens that already use them; this set needs a
// translator pass before it can be localized honestly.
type Row = {
  href: string;
  icon: LucideIcon;
  titleKey: TranslationKey;
  subtitleKey: TranslationKey;
};

const ACCOUNT: Row[] = [
  {
    href: "/profile/details",
    icon: UserRound,
    titleKey: "pp.profile.personal",
    subtitleKey: "pp.profile.personalSub",
  },
  {
    href: "/profile/privacy",
    icon: ShieldCheck,
    titleKey: "pp.profile.privacy",
    subtitleKey: "pp.profile.privacySub",
  },
  {
    // Distinct from Privacy & Security above, which is about who can see you.
    // This is what we hold and what you can make us do with it.
    href: "/profile/data",
    icon: DatabaseZap,
    titleKey: "pp.profile.data",
    subtitleKey: "pp.profile.dataSub",
  },
  {
    // The cases themselves are the existing complaint screens. This is only a
    // way in that does not require remembering which order it was about.
    href: "/profile/grievances",
    icon: ShieldAlert,
    titleKey: "pp.profile.grievances",
    subtitleKey: "pp.profile.grievancesSub",
  },
  {
    href: "/profile/alerts",
    icon: Bell,
    titleKey: "pp.profile.notifs",
    subtitleKey: "pp.profile.notifsSub",
  },
  {
    href: "/profile/payment-methods",
    icon: CreditCard,
    titleKey: "pp.profile.payments",
    subtitleKey: "pp.profile.paymentsSub",
  },
  {
    href: "/profile/rewards",
    icon: Tag,
    titleKey: "pp.profile.rewards",
    subtitleKey: "pp.profile.rewardsSub",
  },
  {
    href: "/history",
    icon: Receipt,
    titleKey: "pp.profile.history",
    subtitleKey: "pp.profile.historySub",
  },
];

const SUPPORT: Row[] = [
  {
    href: "/profile/help",
    icon: LifeBuoy,
    titleKey: "pp.profile.helpCentre",
    subtitleKey: "pp.profile.helpCentreSub",
  },
  {
    href: "/profile/help/contact",
    icon: MessageCircle,
    titleKey: "pp.profile.contact",
    subtitleKey: "pp.profile.contactSub",
  },
];

function RowList({ rows, trailing }: { rows: Row[]; trailing?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
      {rows.map(({ href, icon: Icon, titleKey, subtitleKey }, i) => (
        <StaggerItem key={`${href}-${titleKey}`}>
          <Link
            href={href}
            className={`flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-acct-bg ${
              i < rows.length - 1 || trailing ? "border-b border-line" : ""
            }`}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-acct-tint">
              <Icon size={18} className="text-acct-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-bold text-acct-ink">
                {t(titleKey)}
              </span>
              <span className="block truncate text-[12px] text-acct-muted">
                {t(subtitleKey)}
              </span>
            </span>
            <ChevronRight size={17} className="shrink-0 text-acct-muted" />
          </Link>
        </StaggerItem>
      ))}
      {trailing}
    </div>
  );
}

// Appearance — same row shape as its neighbours, but a toggle rather than a
// chevron-nav link, since flipping it acts immediately instead of going
// anywhere. Figma draws it inline in Account, not tucked a level down in
// Settings (which keeps its own copy — the theme is a per-device choice, so
// having it reachable from two places costs nothing and finding it from
// Account is one tap closer).
function AppearanceRow() {
  const { theme, toggle } = useTheme();
  const { t } = useI18n();
  return (
    <StaggerItem>
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-acct-tint">
          {theme === "dark" ? (
            <Moon size={18} className="text-acct-accent" />
          ) : (
            <Sun size={18} className="text-acct-accent" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold text-acct-ink">
            {t("pp.profile.appearance")}
          </span>
          <span className="block truncate text-[12px] text-acct-muted">
            {t("pp.profile.appearanceSub")}
          </span>
        </span>
        <button
          role="switch"
          aria-checked={theme === "dark"}
          aria-label={t("common.darkMode")}
          onClick={toggle}
          className={`tap-target h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${
            theme === "dark" ? "bg-acct-accent" : "bg-switch-off"
          }`}
        >
          <span
            className={`block size-5 rounded-full bg-white shadow transition-transform ${
              theme === "dark" ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>
    </StaggerItem>
  );
}

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const goBack = useBackTo("/home");
  const [location, setLocation] = useState<string | null>(null);

  const initial = user?.name?.trim()?.[0]?.toUpperCase() ?? "U";

  // The identity strip's third column was a hardcoded city. It comes from the
  // default saved address now, so it says where this account actually is.
  useEffect(() => {
    let cancelled = false;
    api<{ addresses: { city: string; state: string; isDefault: boolean }[] }>(
      "/api/users/addresses",
    )
      .then((d) => {
        if (cancelled) return;
        const a = d.addresses.find((x) => x.isDefault) ?? d.addresses[0];
        setLocation(a ? `${a.city}, ${a.state}` : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        {/* Every other profile screen (Settings, Details, Privacy…) shows its
            own back-arrow title on mobile too via SubPage — this one was the
            odd one out, hiding it under lg: and relying on AppShell's
            generic "Flouna" bar instead, which Figma's frame doesn't draw. */}
        <div className="flex items-center gap-3 py-5">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target rounded-full p-2 text-acct-ink transition-colors hover:bg-acct-ink/5"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-[20px] font-extrabold text-acct-ink">
            {t("pp.profile.title")}
          </h1>
        </div>

        <FadeIn y={10}>
          <div className="flex flex-col items-center pt-6 text-center">
            <div className="relative">
              <span className="flex size-[104px] items-center justify-center overflow-hidden rounded-full bg-acct-tint text-[36px] font-bold text-acct-accent">
                {user?.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.avatarUrl} alt="" className="size-full object-cover" />
                ) : (
                  initial
                )}
              </span>
              <Link
                href="/profile/details"
                aria-label={t("common.editPhoto")}
                className="tap-target absolute bottom-0 right-0 flex size-8 items-center justify-center rounded-full border-2 border-acct-bg bg-black text-white transition-opacity hover:opacity-90"
              >
                <Camera size={14} />
              </Link>
            </div>

            <h2 className="mt-4 text-[24px] font-extrabold text-acct-ink">
              {user?.name ?? t("pf.yourAccount")}
            </h2>

          </div>
        </FadeIn>

        {/* Identity strip. Values come from the account, so a user with no phone
            set sees a prompt to add one rather than an empty column. */}
        <FadeIn delay={0.08}>
          <div className="mt-7 grid grid-cols-3 gap-2 rounded-[18px] bg-card px-3 py-4 text-center shadow-soft">
            {[
              { icon: Mail, value: user?.email ?? t("pf.notAdded"), label: t("pp.profile.email") },
              {
                icon: Phone,
                value: user?.phone ?? t("pp.profile.addPhone"),
                label: t("pp.profile.phone"),
              },
              {
                icon: MapPin,
                value: location ?? t("pp.profile.addAddress"),
                label: t("pp.profile.location"),
              },
            ].map(({ icon: Icon, value, label }) => (
              <div key={label} className="flex min-w-0 flex-col items-center gap-1">
                <Icon size={17} className="text-acct-accent" />
                <span className="w-full truncate text-[12px] font-semibold text-acct-ink">
                  {value}
                </span>
                <span className="text-[11px] text-acct-muted">{label}</span>
              </div>
            ))}
          </div>
        </FadeIn>

        <Stagger delayChildren={0.12} className="mt-7">
          <p className="mb-2 px-1 text-[13px] font-semibold text-acct-muted">
            {t("pp.profile.account")}
          </p>
          <RowList rows={ACCOUNT} trailing={<AppearanceRow />} />

          <p className="mb-2 mt-7 px-1 text-[13px] font-semibold text-acct-muted">
            {t("pp.profile.support")}
          </p>
          <RowList rows={SUPPORT} />
        </Stagger>

        <FadeIn delay={0.3}>
          <button
            onClick={async () => {
              await logout();
              // replace, not push: after signing out, back must not return
              // to a screen this account can no longer see.
              router.replace("/login");
            }}
            className="mt-7 flex w-full items-center justify-center gap-2 rounded-pill bg-danger py-4 text-[16px] font-bold text-white transition-opacity hover:opacity-90"
          >
            <LogOut size={18} /> {t("profile.logout")}
          </button>
        </FadeIn>
      </div>
    </div>
  );
}
