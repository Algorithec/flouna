"use client";

import { useEffect, useState } from "react";
import { PiggyBank, BadgePercent, Sparkles, Pizza, Car } from "lucide-react";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { SubPage } from "@/components/profile/SubPage";
import { Card } from "@/components/ui/Card";
import { CountUp } from "@/components/ui/CountUp";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";
import { useI18n } from "@/components/i18n/I18nContext";

type Savings = {
  totalSavedPaise: number;
  paidOrders: number;
  byDomain?: { food: number; ride: number };
  weekly?: { weekStart: string; savedPaise: number }[];
};

const EMPTY: Savings = { totalSavedPaise: 0, paidOrders: 0 };

export default function RewardsPage() {
  const { t } = useI18n();
  const [savings, setSavings] = useState<Savings | null>(null);

  useEffect(() => {
    api<Savings>("/api/users/savings")
      .then(setSavings)
      .catch(() => setSavings(EMPTY));
  }, []);

  const weekly = savings?.weekly ?? [];
  const hasTrend = weekly.some((w) => w.savedPaise > 0);
  const chartData = weekly.map((w) => ({
    label: new Date(w.weekStart).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
    }),
    rupees: Math.round(w.savedPaise / 100),
  }));
  const food = savings?.byDomain?.food ?? 0;
  const ride = savings?.byDomain?.ride ?? 0;
  const splitTotal = food + ride;

  return (
    <SubPage title={t("profile.rewards")}>
      <FadeIn y={10}>
        <div
          className="relative overflow-hidden rounded-card p-5 text-white shadow-lift"
          style={{ background: "linear-gradient(135deg, #ff8a4c 0%, #e8651a 100%)" }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -right-8 -top-10 size-40 rounded-full bg-white/15 blur-2xl"
          />
          <div className="relative flex items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-[16px] bg-white/20 backdrop-blur">
              <PiggyBank size={24} />
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-white/80">{t("pp.rew.totalSaved")}</p>
              <p className="text-[30px] font-bold leading-tight tracking-tight">
                {savings ? (
                  <CountUp
                    value={savings.totalSavedPaise}
                    format={(n) => rupees(Math.round(n))}
                  />
                ) : (
                  "—"
                )}
              </p>
            </div>
          </div>
          <p className="relative mt-3 text-[12px] text-white/85">
            {savings?.paidOrders
              ? `Across ${savings.paidOrders} order${savings.paidOrders === 1 ? "" : "s"} — versus the next-best option each time.`
              : t("pp.rew.emptyNote")}
          </p>
        </div>
      </FadeIn>

      {/* Weekly savings trend */}
      {hasTrend && (
        <FadeIn delay={0.1} className="mt-5">
          <Card>
            <p className="text-[13px] font-bold text-ink">{t("pp.rew.weekly")}</p>
            <p className="text-[11px] text-cocoa">{t("pp.rew.weeklySub")}</p>
            <div className="mt-3 h-[150px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "#8b5e3c" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(232,101,26,0.08)" }}
                    formatter={(v) => [`₹${Number(v)}`, "Saved"]}
                    contentStyle={{
                      borderRadius: 12,
                      border: "1px solid #eee3da",
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="rupees" fill="#e8651a" radius={[6, 6, 0, 0]} maxBarSize={34} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </FadeIn>
      )}

      {/* Food vs ride split */}
      {splitTotal > 0 && (
        <FadeIn delay={0.15} className="mt-3">
          <Card>
            <p className="text-[13px] font-bold text-ink">{t("pp.rew.where")}</p>
            <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-beige">
              <div
                className="bg-accent"
                style={{ width: `${(food / splitTotal) * 100}%` }}
              />
              <div
                className="bg-[#2f7ec9]"
                style={{ width: `${(ride / splitTotal) * 100}%` }}
              />
            </div>
            <div className="mt-3 flex justify-between text-[12px]">
              <span className="flex items-center gap-1.5 text-cocoa">
                <Pizza size={13} className="text-accent" /> Food
                <b className="text-ink">{rupees(food)}</b>
              </span>
              <span className="flex items-center gap-1.5 text-cocoa">
                <Car size={13} className="text-[#2f7ec9]" /> Rides
                <b className="text-ink">{rupees(ride)}</b>
              </span>
            </div>
          </Card>
        </FadeIn>
      )}

      <h2 className="mt-6 text-[14px] font-bold text-ink">{t("pp.rew.activeOffers")}</h2>
      <Stagger delayChildren={0.15} className="mt-2 flex flex-col gap-2.5">
        <StaggerItem>
          <Card className="transition-all hover:-translate-y-0.5 hover:shadow-card">
            <p className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
              <BadgePercent size={15} className="text-accent" /> Radiues launch offer
            </p>
            <p className="mt-1 text-[12px] text-cocoa">
              Extra savings on in-app orders — applied automatically at checkout.
            </p>
          </Card>
        </StaggerItem>
        <StaggerItem>
          <Card className="transition-all hover:-translate-y-0.5 hover:shadow-card">
            <p className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
              <Sparkles size={15} className="text-accent" /> Smart-pick guarantee
            </p>
            <p className="mt-1 text-[12px] text-cocoa">
              Every recommendation shows you exactly how much you saved versus the
              next-best option.
            </p>
          </Card>
        </StaggerItem>
      </Stagger>
    </SubPage>
  );
}
