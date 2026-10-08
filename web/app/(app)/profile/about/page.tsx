"use client";

import { SubPage } from "@/components/profile/SubPage";
import { Card } from "@/components/ui/Card";
import { useI18n } from "@/components/i18n/I18nContext";
import { FlounaLogo } from "@/components/brand/FlounaLogo";

export default function AboutPage() {
  const { t } = useI18n();
  return (
    <SubPage title={t("profile.about")}>
      <div className="flex flex-col items-center py-4 text-center">
        <FlounaLogo size={84} className="text-ink" />
        <h2 className="mt-3 text-[18px] font-bold text-ink">Flouna</h2>
        <p className="text-[12px] text-cocoa">{t("ab.version").replace("{v}", "0.1.0")}</p>
      </div>

      <Card>
        <p className="text-[13px] leading-relaxed text-cocoa">{t("pp.about.blurb")}</p>
        <p className="mt-3 text-[13px] font-semibold text-ink">{t("pp.about.tagline")}</p>
      </Card>
    </SubPage>
  );
}
