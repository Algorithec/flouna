"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ConsolePage, Card, Table, Badge, Empty, rupees } from "@/components/console/ui";
import { ReportActions } from "@/components/console/ReportActions";

type Row = {
  rank: number;
  city: string;
  state: string;
  tier: string;
  orders: number;
  gmvPaise: number;
  savedPaise: number;
  demo: boolean;
};

type Report = { citiesActive: number; states: string[]; tiers: string[]; rows: Row[] };

const SORTS = [
  { value: "orders", label: "Most orders" },
  { value: "gmv", label: "Highest GMV" },
  { value: "saved", label: "Most saved" },
  { value: "city", label: "City name" },
] as const;
type Sort = (typeof SORTS)[number]["value"];

export default function CityReportPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState("");
  const [tier, setTier] = useState("");
  const [sort, setSort] = useState<Sort>("orders");
  const [error, setError] = useState(false);

  // The filters go to the server, so the export below holds the same rows.
  const query = new URLSearchParams({ sort, ...(state ? { state } : {}), ...(tier ? { tier } : {}) }).toString();

  useEffect(() => {
    let alive = true;
    api<Report>(`/api/console/admin/cities?${query}`)
      .then((d) => {
        if (!alive) return;
        setReport(d);
        setError(false);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [query]);

  const select = "rounded-lg border border-(--c-border) bg-white px-2 py-1.5 text-[13px] text-(--c-ink)";

  return (
    <ConsolePage accept={["admin", "super_admin"]}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-(--c-ink)">City report</h1>
          <p className="mt-1 text-[13px] text-(--c-muted)">
            {report?.citiesActive ?? 0} cities · live volume on our launch city, demo coverage elsewhere (flagged).
          </p>
        </div>
        <ReportActions csvPath={`/api/console/admin/reports/cities.csv?${query}`} name="cities" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px] text-(--c-muted) print:hidden">
        <label className="flex items-center gap-1.5">
          State
          <select value={state} onChange={(e) => setState(e.target.value)} className={select}>
            <option value="">All states</option>
            {report?.states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Tier
          <select value={tier} onChange={(e) => setTier(e.target.value)} className={select}>
            <option value="">All tiers</option>
            {report?.tiers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={select}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="mb-4 rounded-lg bg-[#F6E7E5] px-3 py-2 text-[13px] text-[#C0392B]">Could not load the city report.</p>}

      <Card title="City performance">
        {report && report.rows.length === 0 ? (
          <Empty>No city matches these filters.</Empty>
        ) : (
          <Table head={["#", "City", "State", "Tier", "Orders", "GMV", "Saved", ""]}>
            {report?.rows.map((r) => (
              <tr key={r.city} className="hover:bg-[#f7f1e6]">
                <td className="px-4 py-2.5 text-(--c-muted)">{r.rank}</td>
                <td className="px-4 py-2.5 font-medium text-(--c-ink)">{r.city}</td>
                <td className="px-4 py-2.5 text-(--c-muted)">{r.state}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={r.tier === "Tier 1" ? "blue" : "slate"}>{r.tier}</Badge>
                </td>
                <td className="px-4 py-2.5 text-(--c-ink)">{r.orders}</td>
                <td className="px-4 py-2.5 text-(--c-ink)">{rupees(r.gmvPaise)}</td>
                <td className="px-4 py-2.5 text-[#1a7a4a]">{rupees(r.savedPaise)}</td>
                <td className="px-4 py-2.5">
                  {r.demo ? <Badge tone="amber">demo coverage</Badge> : <Badge tone="green">live</Badge>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </ConsolePage>
  );
}
