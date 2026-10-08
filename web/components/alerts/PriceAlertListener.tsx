"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useEffect, useState } from "react";
import Link from "next/link";
import { TrendingDown, X } from "lucide-react";
import { getSocket } from "@/lib/realtime";
import { rupees } from "@/lib/money";

type AlertEvent = {
  alertId: string;
  itemName: string;
  domain: "food" | "ride";
  newPaise: number;
  targetPaise: number;
};

// Listens for live `price-alert` events and shows a dismissible banner.
// Mounted once in the app shell so it works on every signed-in screen.
export function PriceAlertListener() {
  const { t } = useI18n();
  const [alert, setAlert] = useState<AlertEvent | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const onAlert = (e: AlertEvent) => setAlert(e);
    socket.on("price-alert", onAlert);
    return () => {
      socket.off("price-alert", onAlert);
    };
  }, []);

  if (!alert) return null;

  return (
    <div className="fixed inset-x-0 top-3 z-[60] flex justify-center px-4">
      <div className="flex w-full max-w-md items-start gap-3 rounded-card border border-accent/40 bg-card px-4 py-3 shadow-card animate-fade-up">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
          <TrendingDown size={18} className="text-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-ink">{t("pa.drop")}</p>
          <p className="text-[12px] text-cocoa">
            {(() => {
              const [before, after] = t("pa.now").replace("{item}", alert.itemName).split("{price}");
              return (
                <>
                  {before}
                  <span className="font-semibold text-accent">{rupees(alert.newPaise)}</span>
                  {after}
                </>
              );
            })()}
          </p>
          <Link
            href={alert.domain === "food" ? "/food" : "/rides"}
            onClick={() => setAlert(null)}
            className="mt-1 inline-block text-[12px] font-semibold text-accent hover:underline"
          >
            {t("pa.orderNow")}
          </Link>
        </div>
        <button
          onClick={() => setAlert(null)}
          aria-label={t("common.close")}
          className="rounded-full p-1 text-cocoa/60 hover:bg-beige hover:text-cocoa"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
