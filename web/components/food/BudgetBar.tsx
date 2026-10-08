"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";

export type Budget = {
  budgetPaise: number | null;
  spentPaise: number;
  remainingPaise: number | null;
};

export function useBudget() {
  const [budget, setBudget] = useState<Budget | null>(null);
  useEffect(() => {
    api<Budget>("/api/users/budget")
      .then(setBudget)
      .catch(() => setBudget(null));
  }, []);
  return budget;
}

// Weekly food budget progress — shown on the food landing.
export function BudgetBar({ budget }: { budget: Budget }) {
  const { t } = useI18n();
  if (budget.budgetPaise === null) {
    return (
      <Link
        href="/profile/settings"
        className="mt-4 flex items-center gap-2 rounded-card border border-line bg-card px-3.5 py-2.5 text-[12px] text-cocoa transition-colors hover:bg-beige/30"
      >
        <Wallet size={14} className="text-accent" />
        {t("bb.setBudget")}
      </Link>
    );
  }

  const used = Math.min(1, budget.spentPaise / budget.budgetPaise);
  const over = budget.spentPaise > budget.budgetPaise;

  return (
    <div className="mt-4 rounded-card border border-line bg-card px-3.5 py-3">
      <div className="flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1.5 font-semibold text-ink">
          <Wallet size={13} className="text-accent" /> {t("settings.budgetTitle")}
        </span>
        <span className={cn("font-bold", over ? "text-danger" : "text-success")}>
          {over
            ? `${rupees(budget.spentPaise - budget.budgetPaise)} over`
            : `${rupees(budget.remainingPaise ?? 0)} left`}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-beige">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            over ? "bg-danger" : used > 0.8 ? "bg-accent" : "bg-success",
          )}
          style={{ width: `${Math.max(4, used * 100)}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-cocoa">
        {t("bb.usage")
          .replace("{spent}", rupees(budget.spentPaise))
          .replace("{budget}", rupees(budget.budgetPaise))}
      </p>
    </div>
  );
}
