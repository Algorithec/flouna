"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  UserRound,
  Settings,
  MapPin,
  LifeBuoy,
  Gift,
  Info,
  LogOut,
  ChevronRight,
  Bell,
  Crown,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthContext";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { Card } from "@/components/ui/Card";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { CategoryTile, type TILE_THEMES } from "@/components/ui/CategoryTile";

const MENU: {
  href: string;
  key: TranslationKey;
  icon: typeof UserRound;
  theme: keyof typeof TILE_THEMES;
}[] = [
  { href: "/profile/plus", key: "profile.plus", icon: Crown, theme: "amber" },
  { href: "/profile/details", key: "profile.details", icon: UserRound, theme: "blue" },
  { href: "/profile/settings", key: "profile.settings", icon: Settings, theme: "cocoa" },
  { href: "/profile/alerts", key: "profile.alerts", icon: Bell, theme: "amber" },
  { href: "/profile/addresses", key: "profile.address", icon: MapPin, theme: "green" },
  { href: "/profile/help", key: "profile.help", icon: LifeBuoy, theme: "orange" },
  { href: "/profile/rewards", key: "profile.rewards", icon: Gift, theme: "pink" },
  { href: "/profile/about", key: "profile.about", icon: Info, theme: "purple" },
];

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 lg:max-w-[780px] lg:px-6 lg:py-10">
      <FadeIn y={10}>
        <div className="flex items-center gap-4">
          <span
            className="flex size-16 items-center justify-center rounded-[20px] text-[24px] font-bold text-white shadow-soft"
            style={{ background: "linear-gradient(135deg, #ff8a4c, #e8651a)" }}
          >
            {user?.name?.[0]?.toUpperCase() ?? "U"}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-bold text-ink">{user?.name}</h1>
            <p className="truncate text-[13px] text-cocoa">{user?.email}</p>
          </div>
        </div>
      </FadeIn>

      <Stagger delayChildren={0.1} className="mt-6">
        <Card className="p-0">
          {MENU.map(({ href, key, icon: Icon, theme }, i) => (
            <StaggerItem key={href}>
              <Link
                href={href}
                className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-beige/30 ${
                  i < MENU.length - 1 ? "border-b border-line/70" : ""
                }`}
              >
                <CategoryTile icon={Icon} theme={theme} size={36} />
                <span className="flex-1 text-[14px] font-medium text-ink">{t(key)}</span>
                <ChevronRight size={16} className="text-cocoa/50" />
              </Link>
            </StaggerItem>
          ))}
        </Card>
      </Stagger>

      <FadeIn delay={0.3}>
        <button
          onClick={async () => {
            await logout();
            router.push("/login");
          }}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-pill border border-danger/30 bg-card py-3 text-[14px] font-semibold text-danger transition-colors hover:bg-danger/5"
        >
          <LogOut size={16} /> {t("profile.logout")}
        </button>
      </FadeIn>
    </div>
  );
}
