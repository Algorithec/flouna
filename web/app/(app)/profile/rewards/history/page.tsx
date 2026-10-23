"use client";

import { useEffect, useState } from "react";
import { useBackTo } from "@/lib/navHistory";
import { ArrowLeft, ArrowDownLeft, ArrowUpRight, Gift } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";

// Offers & Rewards → Reward History.
//
// Straight off the wallet ledger, so every line here is the row that produced
// the balance on the previous screen. Credits and debits are shown the same
// way round as a bank statement: sign on the amount, reason in words.

type Entry = {
  id: string;
  amountPaise: number;
  reason: string;
  description: string;
  orderId: string | null;
  createdAt: string;
};

const REASON_KEY: Record<string, TranslationKey> = {
  cashback: "pp.rew.cashback",
  spend: "pp.rew.usedOnOrder",
  refund: "pp.rew.refund",
  adjustment: "pp.rew.adjustment",
};

export default function RewardHistoryPage() {
  const goBack = useBackTo("/profile/rewards");
  const { t, lang } = useI18n();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [balancePaise, setBalancePaise] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ balancePaise: number; entries: Entry[] }>("/api/users/wallet")
      .then((d) => {
        if (cancelled) return;
        setBalancePaise(d.balancePaise);
        setEntries(d.entries);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 shrink-0 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg"
          >
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <h1 className="flex-1 pr-9 text-center text-[17px] font-extrabold text-acct-ink">
            {t("pp.rew.history")}
          </h1>
        </div>

        <div className="rounded-[18px] bg-card px-4 py-3.5 shadow-soft">
          <p className="text-[12px] text-acct-muted">{t("pp.rew.currentBalance")}</p>
          <p className="mt-0.5 text-[22px] font-extrabold text-acct-ink">
            {balancePaise === null ? "..." : rupees(balancePaise)}
          </p>
        </div>

        <div className="mt-5 overflow-hidden rounded-[18px] bg-card shadow-soft">
          {entries === null ? (
            <p className="px-4 py-8 text-center text-[13px] text-acct-muted">
              {t("common.loading")}
            </p>
          ) : entries.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-acct-tint">
                <Gift size={22} className="text-acct-accent" />
              </span>
              <p className="mt-3 text-[15px] font-bold text-acct-ink">
                {t("pp.rew.noRewards")}
              </p>
              <p className="mt-1 text-[13px] text-acct-muted">
                {t("pp.rew.noRewardsSub")}
              </p>
            </div>
          ) : (
            entries.map((e, i) => {
              const credit = e.amountPaise >= 0;
              return (
                <div
                  key={e.id}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3.5",
                    i < entries.length - 1 && "border-b border-line",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-full",
                      credit ? "bg-success-soft" : "bg-acct-tint",
                    )}
                  >
                    {credit ? (
                      <ArrowDownLeft size={17} className="text-success" />
                    ) : (
                      <ArrowUpRight size={17} className="text-acct-accent" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-3 text-[15px] font-bold text-acct-ink">
                      {e.description}
                    </span>
                    <span className="line-clamp-2 text-[12px] text-acct-muted">
                      {REASON_KEY[e.reason] ? t(REASON_KEY[e.reason]) : e.reason} ·{" "}
                      {new Date(e.createdAt).toLocaleDateString(`${lang}-IN`, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[15px] font-extrabold",
                      credit ? "text-success" : "text-acct-ink",
                    )}
                  >
                    {credit ? "+" : "−"}
                    {rupees(Math.abs(e.amountPaise))}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
