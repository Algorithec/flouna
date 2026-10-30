"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatCard, PageTitle } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Empty, Badge, rupeesCompact, rupees } from "@/components/console/ui";
import { DonutChart, BarChartC, LineChartC } from "@/components/console/charts";
import { ReportActions } from "@/components/console/ReportActions";

type Dashboard = {
  totalOrders: number;
  gmvPaise: number;
  ondcOrders: number;
  ondcSharePct: number;
  activeUsers: number;
  newUsers7d: number;
  userSavedPaise: number;
  revenue: { ondcPaise: number; partnerPaise: number; conveniencePaise: number; totalPaise: number };
  domainBreakdown: { domain: string; count: number }[];
};

type TrendDay = {
  date: string;
  signups: number;
  users: number;
  orders: number;
  ondcOrders: number;
  ondcSharePct: number | null;
  savedPaise: number;
};
type Trends = {
  days: number;
  series: TrendDay[];
  totals: { signups: number; orders: number; ondcOrders: number; ondcSharePct: number | null; savedPaise: number; usersAtStart: number; usersNow: number };
};

type ServiceState = "on" | "off" | "sandbox" | "simulated";
type Health = {
  checkedAt: string;
  uptimeSeconds: number;
  database: { ok: boolean; latencyMs: number | null };
  alerts: { critical: number; warning: number } | null;
  services: { name: string; state: ServiceState; note?: string }[];
};

const STATE: Record<ServiceState, { label: string; tone: "green" | "slate" | "amber" | "blue" }> = {
  on: { label: "On", tone: "green" },
  off: { label: "Off", tone: "slate" },
  sandbox: { label: "Sandbox", tone: "amber" },
  simulated: { label: "Simulated", tone: "blue" },
};

// "30 Oct" from an Indian calendar day, without the browser's zone moving it.
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function AdminDashboardPage() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    api<Dashboard>("/api/console/admin/dashboard").then(setD).catch(() => {});
    api<Trends>("/api/console/admin/reports/trends?days=30").then(setTrends).catch(() => {});
    api<Health>("/api/console/admin/system-health")
      .then(setHealth)
      .catch(() => setHealthError(true));
  }, []);

  const domainData =
    d?.domainBreakdown.map((x) => ({ name: x.domain, value: x.count })) ?? [];
  const revenueData = d
    ? [
        { name: "ONDC", value: Math.round(d.revenue.ondcPaise / 100) },
        { name: "Partner", value: Math.round(d.revenue.partnerPaise / 100) },
        { name: "Convenience", value: Math.round(d.revenue.conveniencePaise / 100) },
      ]
    : [];
  const series = trends?.series ?? [];
  const userGrowth = series.map((x) => ({ name: dayLabel(x.date), value: x.users }));
  // A day with no paid orders has no share: a gap in the line, not 0%, which
  // would read as every order going elsewhere.
  const ondcShare = series.map((x) => ({ name: dayLabel(x.date), value: x.ondcSharePct }));
  const anyShare = series.some((x) => x.ondcSharePct != null);
  const savings = series.map((x) => ({ name: dayLabel(x.date), value: Math.round(x.savedPaise / 100) }));
  const t = trends?.totals;

  return (
    <ConsolePage accept={["admin", "super_admin"]}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle
          title="Dashboard"
          subtitle="Live snapshot across the decision engine. All figures computed server-side."
        />
        <ReportActions csvPath="/api/console/admin/reports/dashboard.csv" name="dashboard" className="mb-4" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Total orders" value={d?.totalOrders ?? "No data"} />
        <StatCard label="GMV" value={d ? rupeesCompact(d.gmvPaise) : "No data"} tone="good" />
        <StatCard
          label="ONDC orders"
          value={d?.ondcOrders ?? "No data"}
          hint={d ? `${d.ondcSharePct}% of paid` : undefined}
        />
        <StatCard label="Active users" value={d?.activeUsers ?? "No data"} hint={d ? `+${d.newUsers7d} new (7d)` : undefined} />
        <StatCard label="Saved for users" value={d ? rupeesCompact(d.userSavedPaise) : "No data"} tone="good" hint="On paid orders" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Revenue · total" value={d ? rupees(d.revenue.totalPaise) : "No data"} tone="good" />
        <StatCard label="· ONDC margin" value={d ? rupees(d.revenue.ondcPaise) : "No data"} />
        <StatCard label="· Partner" value={d ? rupees(d.revenue.partnerPaise) : "No data"} />
        <StatCard label="· Convenience" value={d ? rupees(d.revenue.conveniencePaise) : "No data"} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="User growth (30 days)">
          <div className="p-4">
            {t && (
              <p className="mb-2 text-[13px] text-(--c-muted)">
                {t.usersAtStart} to {t.usersNow} accounts, {t.signups} new
              </p>
            )}
            {userGrowth.length ? <LineChartC data={userGrowth} height={200} /> : <Empty>No data yet.</Empty>}
          </div>
        </Card>
        <Card title="ONDC share of paid orders">
          <div className="p-4">
            {t && (
              <p className="mb-2 text-[13px] text-(--c-muted)">
                {t.ondcSharePct == null ? "No paid orders in 30 days" : `${t.ondcSharePct}% over 30 days, ${t.ondcOrders} of ${t.orders}`}
              </p>
            )}
            {anyShare ? (
              <LineChartC data={ondcShare} height={200} valueLabel={(v) => `${v}%`} />
            ) : (
              <Empty>No paid orders in this period.</Empty>
            )}
          </div>
        </Card>
        <Card title="Consumer savings (₹ a day)">
          <div className="p-4">
            {t && <p className="mb-2 text-[13px] text-(--c-muted)">{rupees(t.savedPaise)} saved on paid orders over 30 days</p>}
            {savings.length ? (
              <LineChartC data={savings} height={200} valueLabel={(v) => `₹${v.toLocaleString("en-IN")}`} />
            ) : (
              <Empty>No data yet.</Empty>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Orders by domain">
          <div className="p-4">
            {domainData.length ? (
              <DonutChart data={domainData} />
            ) : (
              <Empty>No paid orders yet, place a test order to populate this.</Empty>
            )}
          </div>
        </Card>
        <Card title="Revenue split (₹)">
          <div className="p-4">
            {d && d.revenue.totalPaise > 0 ? (
              <BarChartC data={revenueData} colorful valueLabel={(v) => `₹${v.toLocaleString("en-IN")}`} />
            ) : (
              <Empty>No revenue yet.</Empty>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4">
        <Card
          title="System health"
          right={health ? <span className="text-[12px] text-(--c-muted)">{`Up ${uptime(health.uptimeSeconds)}`}</span> : undefined}
        >
          {healthError ? (
            <Empty>Could not reach the server for a health check.</Empty>
          ) : !health ? (
            <Empty>Checking…</Empty>
          ) : (
            <div className="grid gap-x-6 gap-y-2 p-4 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-(--c-ink)">Database</span>
                {health.database.ok ? (
                  <Badge tone="green">{`OK, ${health.database.latencyMs} ms`}</Badge>
                ) : (
                  <Badge tone="red">Not answering</Badge>
                )}
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-(--c-ink)">Open alerts</span>
                {health.alerts == null ? (
                  <Badge tone="slate">Unknown</Badge>
                ) : health.alerts.critical > 0 ? (
                  <Badge tone="red">{`${health.alerts.critical} critical, ${health.alerts.warning} warning`}</Badge>
                ) : health.alerts.warning > 0 ? (
                  <Badge tone="amber">{`${health.alerts.warning} warning`}</Badge>
                ) : (
                  <Badge tone="green">None</Badge>
                )}
              </div>
              {health.services.map((s) => (
                <div key={s.name} className="flex items-center justify-between gap-3">
                  <span className="text-(--c-ink)">
                    {s.name}
                    {s.note && <span className="block text-[11px] text-(--c-muted)">{s.note}</span>}
                  </span>
                  <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </ConsolePage>
  );
}
