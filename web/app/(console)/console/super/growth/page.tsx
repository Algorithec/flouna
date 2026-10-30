"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api, API_URL } from "@/lib/api";
import { StatCard, PageTitle } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Empty, rupeesCompact } from "@/components/console/ui";
import { LineChartC, BarChartC } from "@/components/console/charts";

type Growth = {
  days: number;
  series: { date: string; orders: number; gmvPaise: number; signups: number }[];
  totals: { orders: number; gmvPaise: number; signups: number; activeBuyers7d: number };
  weekOverWeek: {
    ordersThisWeek: number;
    ordersLastWeek: number;
    gmvThisWeekPaise: number;
    gmvLastWeekPaise: number;
  };
};

// "2026-07-02" → "2 Jul" for compact chart axes.
function shortDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

// WoW movement as a signed percentage label; "No data" when there is no base week.
function delta(now: number, prev: number): string {
  if (prev === 0) return now > 0 ? "new" : "No data";
  const pct = Math.round(((now - prev) / prev) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}% WoW`;
}

// Fetch a CSV with the session cookie and hand it to the browser as a download.
async function downloadCsv(name: "orders" | "users") {
  const res = await fetch(`${API_URL}/api/console/super/export/${name}.csv`, {
    credentials: "include",
  });
  if (!res.ok) return;
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function GrowthPage() {
  const [g, setG] = useState<Growth | null>(null);

  useEffect(() => {
    api<Growth>("/api/console/super/growth").then(setG).catch(() => {});
  }, []);

  const gmvSeries =
    g?.series.map((s) => ({ name: shortDay(s.date), value: Math.round(s.gmvPaise / 100) })) ?? [];
  const orderSeries = g?.series.map((s) => ({ name: shortDay(s.date), value: s.orders })) ?? [];
  const signupSeries = g?.series.map((s) => ({ name: shortDay(s.date), value: s.signups })) ?? [];
  const anyVolume = (g?.totals.orders ?? 0) > 0 || (g?.totals.signups ?? 0) > 0;

  return (
    <ConsolePage accept={["super_admin"]}>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageTitle
          title="Growth"
          subtitle={`Daily orders, GMV and signups, last ${g?.days ?? 30} days, from real data.`}
        />
        <div className="flex shrink-0 gap-2 pt-1">
          <button
            onClick={() => downloadCsv("orders")}
            className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-[12px] font-semibold"
            style={{ border: "1px solid var(--c-border)", color: "var(--c-ink)" }}
          >
            <Download size={13} /> Orders CSV
          </button>
          <button
            onClick={() => downloadCsv("users")}
            className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-[12px] font-semibold"
            style={{ border: "1px solid var(--c-border)", color: "var(--c-ink)" }}
          >
            <Download size={13} /> Users CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Orders (30d)"
          value={g?.totals.orders ?? "No data"}
          hint={g ? delta(g.weekOverWeek.ordersThisWeek, g.weekOverWeek.ordersLastWeek) : undefined}
        />
        <StatCard
          label="GMV (30d)"
          value={g ? rupeesCompact(g.totals.gmvPaise) : "No data"}
          tone="good"
          hint={g ? delta(g.weekOverWeek.gmvThisWeekPaise, g.weekOverWeek.gmvLastWeekPaise) : undefined}
        />
        <StatCard label="New signups (30d)" value={g?.totals.signups ?? "No data"} />
        <StatCard label="Active buyers (7d)" value={g?.totals.activeBuyers7d ?? "No data"} tone="warn" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="GMV per day (₹)">
          <div className="p-4">
            {anyVolume ? (
              <LineChartC data={gmvSeries} valueLabel={(v) => `₹${v.toLocaleString("en-IN")}`} />
            ) : (
              <Empty>No volume yet, paid orders populate this.</Empty>
            )}
          </div>
        </Card>
        <Card title="Orders per day">
          <div className="p-4">
            {anyVolume ? <LineChartC data={orderSeries} /> : <Empty>No orders yet.</Empty>}
          </div>
        </Card>
      </div>

      <div className="mt-4">
        <Card title="Signups per day">
          <div className="p-4">
            {anyVolume ? <BarChartC data={signupSeries} height={200} /> : <Empty>No signups in this window.</Empty>}
          </div>
        </Card>
      </div>
    </ConsolePage>
  );
}
