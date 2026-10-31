"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api, ApiClientError, API_URL } from "@/lib/api";
import { StatCard } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Badge, Empty, Table } from "@/components/console/ui";

// Our commission on ONDC orders and the settlements that do not add up,
// worked out from the settlement rows on the server. Amounts to the paisa:
// commission and its variances are small, and rounding would hide them.

type Totals = {
  orders: number;
  orderValuePaise: number;
  expectedPaise: number;
  confirmedPaise: number;
  receivedPaise: number;
  outstandingPaise: number;
  variancePaise: number;
};

type Exception = {
  settlementId: string;
  reason: "amount_mismatch" | "dispute" | "failed" | "overdue" | "held_too_long";
  status: "open" | "investigating" | "resolved";
  note: string | null;
  bppId: string;
  networkOrderId: string;
  role: "receiver" | "collector";
  settlementStatus: string;
  dueAt: string;
  feePaise: number;
  duePaise: number;
  settledPaise: number | null;
  variancePaise: number | null;
  errorMessage: string | null;
};

type Report = { totals: Totals; bySellerApp: (Totals & { bppId: string })[]; exceptions: Exception[] };

const REASON: Record<Exception["reason"], string> = {
  amount_mismatch: "Amount differs",
  dispute: "Seller app disputes",
  failed: "Settlement failed",
  overdue: "Overdue",
  held_too_long: "Held over 7 days",
};

function inr(paise: number | null): string {
  if (paise == null) return "n/a";
  const amount = (Math.abs(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${paise < 0 ? "-" : ""}₹${amount}`;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function CommissionPage() {
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  // Bumped after a decision, so the queue is read again from the server.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    api<Report>(`/api/console/admin/ondc/commission?from=${from}&to=${to}`)
      .then((r) => {
        if (!alive) return;
        setReport(r);
        setError("");
      })
      .catch((e) => alive && setError(e instanceof ApiClientError ? e.message : "Could not load the commission report."));
    return () => {
      alive = false;
    };
  }, [from, to, reload]);

  async function decide(x: Exception, status: "investigating" | "resolved") {
    const key = `${x.settlementId}:${x.reason}`;
    try {
      await api("/api/console/admin/ondc/commission/exceptions", {
        method: "POST",
        json: { settlementId: x.settlementId, reason: x.reason, status, note: notes[key]?.trim() || undefined },
      });
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not save that.");
    }
  }

  const t = report?.totals;
  const queue = report?.exceptions.filter((x) => showResolved || x.status !== "resolved") ?? [];

  return (
    <ConsolePage accept={["admin", "super_admin"]}>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-(--c-ink)">Commission &amp; reconciliation</h1>
          <p className="mt-1 text-[13px] text-(--c-muted)">
            Our Buyer Finder Fee on ONDC orders: what is due, what the seller apps agreed, what reached us, and the
            settlements that do not add up.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <label className="flex items-center gap-1.5 text-(--c-muted)">
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-(--c-border) bg-white px-2 py-1 text-(--c-ink)" />
          </label>
          <label className="flex items-center gap-1.5 text-(--c-muted)">
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-(--c-border) bg-white px-2 py-1 text-(--c-ink)" />
          </label>
          <a
            href={`${API_URL}/api/console/admin/ondc/commission.csv?from=${from}&to=${to}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-(--c-border) bg-white px-3 py-1.5 font-medium text-(--c-ink) hover:bg-(--c-ivory)"
          >
            <Download size={14} /> Export CSV
          </a>
        </div>
      </div>

      {error && <p className="mb-4 rounded-lg bg-[#F6E7E5] px-3 py-2 text-[13px] text-[#C0392B]">{error}</p>}

      {t && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Commission due" value={inr(t.expectedPaise)} hint={`${t.orders} orders, ${inr(t.orderValuePaise)} order value`} />
          <StatCard label="Agreed by seller apps" value={inr(t.confirmedPaise)} />
          <StatCard label="Received" value={inr(t.receivedPaise)} tone="good" />
          <StatCard label="Outstanding" value={inr(t.outstandingPaise)} tone={t.outstandingPaise > 0 ? "warn" : "good"} />
          <StatCard label="Variance" value={inr(t.variancePaise)} tone={t.variancePaise !== 0 ? "bad" : "good"} hint="Settled less due" />
        </div>
      )}

      {report && (
        <div className="grid gap-4">
          <Card title="By seller app">
            {report.bySellerApp.length === 0 ? (
              <Empty>No completed ONDC orders in this period.</Empty>
            ) : (
              <Table head={["Seller app", "Orders", "Due", "Agreed", "Received", "Outstanding", "Variance"]}>
                {report.bySellerApp.map((a) => (
                  <tr key={a.bppId}>
                    <td className="px-4 py-2 font-mono">{a.bppId}</td>
                    <td className="px-4 py-2">{a.orders}</td>
                    <td className="px-4 py-2">{inr(a.expectedPaise)}</td>
                    <td className="px-4 py-2">{inr(a.confirmedPaise)}</td>
                    <td className="px-4 py-2">{inr(a.receivedPaise)}</td>
                    <td className="px-4 py-2">{inr(a.outstandingPaise)}</td>
                    <td className="px-4 py-2">{a.variancePaise !== 0 ? <Badge tone="red">{inr(a.variancePaise)}</Badge> : inr(0)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card
            title={`Exceptions (${report.exceptions.filter((x) => x.status !== "resolved").length} open or investigating)`}
            right={
              <label className="flex items-center gap-1.5 text-[12px] text-(--c-muted)">
                <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
                Show resolved
              </label>
            }
          >
            {queue.length === 0 ? (
              <Empty>Nothing to look at.</Empty>
            ) : (
              <Table head={["Reason", "Seller app and order", "Due", "Settled", "Status", "Note", ""]}>
                {queue.map((x) => {
                  const key = `${x.settlementId}:${x.reason}`;
                  return (
                    <tr key={key}>
                      <td className="px-4 py-2">
                        <Badge tone={x.reason === "amount_mismatch" || x.reason === "failed" ? "red" : "amber"}>{REASON[x.reason]}</Badge>
                        {x.errorMessage && <p className="mt-1 max-w-[220px] text-[11px] text-(--c-muted)">{x.errorMessage}</p>}
                      </td>
                      <td className="px-4 py-2">
                        <p className="font-mono">{x.bppId}</p>
                        <p className="font-mono text-(--c-muted)">{x.networkOrderId}</p>
                        <p className="text-(--c-muted)">
                          {x.role === "receiver" ? "Seller app collected" : "Flouna collected"}, {x.settlementStatus}, due {x.dueAt.slice(0, 10)}
                        </p>
                      </td>
                      <td className="px-4 py-2">{inr(x.duePaise)}</td>
                      <td className="px-4 py-2">
                        {inr(x.settledPaise)}
                        {x.variancePaise != null && x.variancePaise !== 0 && <p className="text-[#C0392B]">{inr(x.variancePaise)}</p>}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={x.status === "resolved" ? "green" : x.status === "investigating" ? "blue" : "slate"}>{x.status}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        <input
                          value={notes[key] ?? x.note ?? ""}
                          onChange={(e) => setNotes((n) => ({ ...n, [key]: e.target.value }))}
                          maxLength={500}
                          placeholder="What was found"
                          aria-label="Note"
                          className="w-44 rounded border border-(--c-border) px-2 py-1"
                        />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <button type="button" onClick={() => decide(x, "investigating")} className="mr-2 text-[12px] font-semibold text-(--c-maroon) hover:underline">
                          Investigating
                        </button>
                        <button type="button" onClick={() => decide(x, "resolved")} className="text-[12px] font-semibold text-[#1A7A4A] hover:underline">
                          Resolve
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </div>
      )}
    </ConsolePage>
  );
}
