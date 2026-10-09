"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Tag, Award, Zap, Gift } from "lucide-react";
import { api } from "@/lib/api";

type PlusStatus = {
  active: boolean;
  pricePaise: number;
  perks: string[];
};

let statusRequest: Promise<PlusStatus> | null = null;

function subscriptionStatus(): Promise<PlusStatus> {
  statusRequest ??= api<PlusStatus>("/api/subscription").catch((err) => {
    statusRequest = null;
    throw err;
  });
  return statusRequest;
}

export function RadiusUpsell({ href = "/profile/rewards" }: { href?: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<PlusStatus | null>(null);

  useEffect(() => {
    let active = true;
    subscriptionStatus()
      .then((res) => {
        if (active) setStatus(res);
      })
      .catch(() => {
        // Fail silent: safe default is to hide the upsell rather than show it
        // to someone who might already be paying for it.
      });
    return () => {
      active = false;
    };
  }, []);

  if (!status || status.active) return null;

  return (
    <div className="rounded-[18px] border border-accent/25 bg-card px-4 py-5 text-center">
      <h3 className="text-[16px] font-bold text-ink">{t("ru.title")}</h3>
      <p className="mt-1 text-[12.5px] text-cocoa">{t("ru.sub")}</p>

      <div className="mt-4 grid grid-cols-4 gap-1">
        <Perk icon={Tag} label={t("ru.bestPrices")} />
        <Perk icon={Award} label={t("ru.topRated")} />
        <Perk icon={Zap} label={t("ru.fast")} />
        <Perk icon={Gift} label={t("ru.offers")} />
      </div>

      <Link
        href={href}
        className="tap-target mt-4 flex w-full items-center justify-center rounded-full border border-accent/60 py-2.5 text-[14px] font-semibold text-accent transition-colors hover:bg-accent-soft/50"
      >
        {t("ru.explore")}
      </Link>
    </div>
  );
}

function Perk({ icon: Icon, label }: { icon: typeof Tag; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <span className="flex size-9 items-center justify-center rounded-full border border-accent/30 text-accent">
        <Icon size={16} />
      </span>
      <span className="text-[10px] font-semibold leading-tight text-ink">{label}</span>
    </div>
  );
}
