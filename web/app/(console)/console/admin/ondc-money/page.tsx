"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Send } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

// The money side of ONDC orders, in one place for an operator:
//
//   Settlements  what each completed order settles through the settlement
//                agency (RSF). Nothing is sent until a person sends it, and
//                anything that moves money asks for a second click.
//   Payouts      seller payouts recorded for paying by hand (orders Flouna
//                collected for). One paid through the agency shows as such
//                and cannot also be recorded as paid here.
//   Refunds      refunds the system would not settle on its own.

type Settlement = {
  id: string;
  bppId: string;
  networkOrderId: string;
  role: "receiver" | "collector";
  orderTotalPaise: number;
  feePaise: number;
  interParticipantPaise: number;
  dueAt: string;
  status: "held" | "due" | "instructed" | "settled" | "not_settled";
  note: string | null;
  settlementId: string | null;
  referenceNo: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  reconStatus: string | null;
};

type Payout = {
  id: string;
  ondcOrderId: string;
  bppId: string;
  amountPaise: number;
  feePaise: number;
  dueAt: string;
  status: string;
  note: string | null;
  overdue: boolean;
};

type Refund = {
  id: string;
  storeName: string;
  paidPaise: number | null;
  totalPaise: number | null;
  refundPaise: number | null;
  refundStatus: string | null;
  problem: string | null;
};

const rupees = (paise: number | null | undefined) => (paise == null ? "No amount" : `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const TABS = [
  { key: "settlements", label: "Settlements" },
  { key: "payouts", label: "Seller payouts" },
  { key: "refunds", label: "Refunds needing attention" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const STATUS_FILTERS = ["", "held", "due", "instructed", "settled", "not_settled"] as const;

const message = (err: unknown, fallback: string) => (err instanceof ApiClientError ? err.message : fallback);

export default function OndcMoneyPage() {
  const state = useOperator(["admin", "super_admin"]);
  const [tab, setTab] = useState<Tab>("settlements");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  if (state.status !== "ok") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-(--c-muted)">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <ConsoleShell operator={state.operator}>
      <PageTitle title="ONDC money" />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="ONDC money">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => {
              setTab(t.key);
              setNotice(null);
            }}
            className={
              tab === t.key
                ? "rounded-lg bg-(--c-ink) px-3 py-1.5 text-[13px] font-medium text-white"
                : "rounded-lg border border-(--c-border) bg-white px-3 py-1.5 text-[13px] text-(--c-ink) hover:bg-[#f0e8da]"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${
            notice.kind === "error" ? "bg-(--c-red)/10 text-(--c-red)" : "bg-[#1a7a4a]/10 text-[#1a7a4a]"
          }`}
        >
          {notice.kind === "error" ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />} {notice.text}
        </p>
      )}

      {tab === "settlements" && <Settlements onNotice={setNotice} />}
      {tab === "payouts" && <Payouts onNotice={setNotice} />}
      {tab === "refunds" && <Refunds onNotice={setNotice} />}
    </ConsoleShell>
  );
}

type NoticeFn = (n: { kind: "ok" | "error"; text: string } | null) => void;

function Settlements({ onNotice }: { onNotice: NoticeFn }) {
  const [rows, setRows] = useState<Settlement[]>([]);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // A money action is armed by the first click and sent by the second.
  const [armed, setArmed] = useState<string | null>(null);
  // When the list was fetched: "due now" is judged against that, not re-read
  // on every render.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(() => {
    api<{ settlements: Settlement[] }>(`/api/console/admin/ondc/settlements${status ? `?status=${status}` : ""}`)
      .then((d) => {
        setRows(d.settlements);
        setLoadedAt(Date.now());
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  // Due settlements, grouped as one instruction each: one seller app, one role.
  const groups = useMemo(() => {
    const g = new Map<string, { bppId: string; role: Settlement["role"]; count: number; paise: number }>();
    for (const r of rows) {
      if (r.status !== "due" || new Date(r.dueAt).getTime() > loadedAt) continue;
      const key = `${r.bppId}|${r.role}`;
      const cur = g.get(key) ?? { bppId: r.bppId, role: r.role, count: 0, paise: 0 };
      cur.count++;
      cur.paise += r.interParticipantPaise;
      g.set(key, cur);
    }
    return [...g.values()];
  }, [rows, loadedAt]);

  async function run(key: string, action: () => Promise<unknown>, done: string, failed: string) {
    setBusy(key);
    onNotice(null);
    try {
      await action();
      onNotice({ kind: "ok", text: done });
      load();
    } catch (err) {
      onNotice({ kind: "error", text: message(err, failed) });
    } finally {
      setBusy(null);
      setArmed(null);
    }
  }

  const instruct = (bppId: string, role: Settlement["role"]) => {
    const key = `instruct|${bppId}|${role}`;
    if (armed !== key) return setArmed(key);
    void run(
      key,
      () => api("/api/console/admin/ondc/settlements/instruct", { method: "POST", json: { bppId, role } }),
      `Sent the settlement agency instructions for ${bppId}.`,
      "Nothing was sent. Try again.",
    );
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as (typeof STATUS_FILTERS)[number])}
          aria-label="Filter by status"
          className="rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[13px] text-(--c-ink)"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "" ? "All statuses" : s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            if (armed !== "nil") return setArmed("nil");
            void run("nil", () => api("/api/console/admin/ondc/settlements/nil", { method: "POST" }), "Declared a nil cycle to the settlement agency.", "The nil declaration was not sent.");
          }}
          disabled={busy !== null}
          className="rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[13px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
        >
          {armed === "nil" ? "Confirm: nothing to settle this cycle" : "Declare a nil cycle"}
        </button>
      </div>

      {groups.length > 0 && (
        <div className="mb-4 rounded-xl border border-(--c-border) bg-white p-3">
          <p className="mb-2 text-[13px] font-medium text-(--c-ink)">Ready to send to the settlement agency</p>
          <div className="flex flex-col gap-2">
            {groups.map((g) => {
              const key = `instruct|${g.bppId}|${g.role}`;
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                  <span className="text-(--c-ink)">
                    {g.count} {g.count === 1 ? "order" : "orders"} with <b>{g.bppId}</b>:{" "}
                    {g.role === "receiver" ? `we receive ${rupees(g.paise)}` : `we pay ${rupees(g.paise)}`}
                  </span>
                  <button
                    onClick={() => instruct(g.bppId, g.role)}
                    disabled={busy !== null}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] disabled:opacity-50 ${
                      armed === key ? "bg-(--c-red) text-white" : "border border-(--c-border) text-(--c-ink) hover:bg-[#f0e8da]"
                    }`}
                  >
                    {busy === key ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    {armed === key ? "Confirm send" : "Send instruction"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-(--c-muted)">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-(--c-border)">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white text-[12px] uppercase tracking-wide text-(--c-muted)">
              <tr>
                <th className="px-4 py-2.5 font-medium">Order</th>
                <th className="px-4 py-2.5 font-medium">Who collected</th>
                <th className="px-4 py-2.5 font-medium">Order / fee</th>
                <th className="px-4 py-2.5 font-medium">Moves</th>
                <th className="px-4 py-2.5 font-medium">Due</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-(--c-line)">
              {rows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-[#f7f1e6]">
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-(--c-ink)">{r.networkOrderId}</p>
                    <p className="text-[12px] text-(--c-muted)">{r.bppId}</p>
                  </td>
                  <td className="px-4 py-2.5 text-(--c-ink)">{r.role === "receiver" ? "Seller (we receive our fee)" : "Flouna (we pay the seller)"}</td>
                  <td className="px-4 py-2.5 text-(--c-ink)">
                    {rupees(r.orderTotalPaise)}
                    <p className="text-[12px] text-(--c-muted)">fee {rupees(r.feePaise)}</p>
                  </td>
                  <td className="px-4 py-2.5 text-(--c-ink)">{rupees(r.interParticipantPaise)}</td>
                  <td className="px-4 py-2.5 text-(--c-muted)">{day(r.dueAt)}</td>
                  <td className="max-w-[260px] px-4 py-2.5">
                    <p className={r.status === "settled" ? "text-[#1a7a4a]" : r.status === "not_settled" || r.note?.startsWith("PAID TWICE") ? "text-(--c-red)" : "text-(--c-ink)"}>
                      {r.status.replace(/_/g, " ")}
                      {r.reconStatus ? ` · recon ${r.reconStatus}` : ""}
                    </p>
                    {r.referenceNo && <p className="text-[12px] text-(--c-muted)">ref {r.referenceNo}</p>}
                    {(r.errorMessage || r.errorCode) && <p className="text-[12px] text-(--c-red)">{[r.errorCode, r.errorMessage].filter(Boolean).join(": ")}</p>}
                    {r.note && <p className="text-[12px] text-(--c-muted)">{r.note}</p>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <div className="flex flex-col items-end gap-1">
                      {r.status === "held" && (
                        <button
                          onClick={() => {
                            const key = `release|${r.id}`;
                            if (armed !== key) return setArmed(key);
                            void run(key, () => api(`/api/console/admin/ondc/settlements/${r.id}/release`, { method: "POST" }), "Released. It goes into the next instruction.", "Not released.");
                          }}
                          disabled={busy !== null}
                          className="rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                        >
                          {armed === `release|${r.id}` ? "Confirm release" : "Release"}
                        </button>
                      )}
                      {r.status === "instructed" && r.settlementId && (
                        <button
                          onClick={() => void run(`report|${r.id}`, () => api("/api/console/admin/ondc/settlements/report", { method: "POST", json: { settlementId: r.settlementId } }), "Asked the agency for the instruction's status.", "The request was not sent.")}
                          disabled={busy !== null}
                          className="rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                        >
                          Ask agency for status
                        </button>
                      )}
                      <button
                        onClick={() => void run(`recon|${r.id}`, () => api("/api/console/admin/ondc/settlements/recon", { method: "POST", json: { ids: [r.id] } }), "Sent our figures to the seller app to reconcile.", "The reconciliation was not sent.")}
                        disabled={busy !== null}
                        className="rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                      >
                        Reconcile with seller
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-(--c-muted)">
                    No settlements.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Payouts({ onNotice }: { onNotice: NoticeFn }) {
  const [rows, setRows] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [utr, setUtr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ payouts: Payout[] }>("/api/console/admin/ondc/payouts")
      .then((d) => setRows(d.payouts))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function markPaid(id: string) {
    setBusy(id);
    onNotice(null);
    try {
      await api(`/api/console/admin/ondc/payouts/${id}/paid`, { method: "POST", json: { utr: (utr[id] ?? "").trim() } });
      onNotice({ kind: "ok", text: "Recorded as paid." });
      load();
    } catch (err) {
      onNotice({ kind: "error", text: message(err, "Not recorded. Check the bank reference and try again.") });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-(--c-muted)">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-(--c-border)">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-white text-[12px] uppercase tracking-wide text-(--c-muted)">
          <tr>
            <th className="px-4 py-2.5 font-medium">Seller app</th>
            <th className="px-4 py-2.5 font-medium">Pay the seller</th>
            <th className="px-4 py-2.5 font-medium">Due</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium text-right">Record a transfer</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-(--c-line)">
          {rows.map((p) => (
            <tr key={p.id} className="align-top hover:bg-[#f7f1e6]">
              <td className="px-4 py-2.5 text-(--c-ink)">{p.bppId}</td>
              <td className="px-4 py-2.5 text-(--c-ink)">
                {rupees(p.amountPaise)}
                <p className="text-[12px] text-(--c-muted)">our fee {rupees(p.feePaise)}</p>
              </td>
              <td className={`px-4 py-2.5 ${p.overdue ? "text-(--c-red)" : "text-(--c-muted)"}`}>{day(p.dueAt)}</td>
              <td className="max-w-[260px] px-4 py-2.5">
                <p className="text-(--c-ink)">{p.status}</p>
                {p.note && <p className="text-[12px] text-(--c-muted)">{p.note}</p>}
              </td>
              <td className="px-4 py-2.5 text-right">
                <div className="flex items-center justify-end gap-2">
                  <input
                    value={utr[p.id] ?? ""}
                    onChange={(e) => setUtr((u) => ({ ...u, [p.id]: e.target.value }))}
                    placeholder="Bank reference (UTR)"
                    aria-label={`Bank reference for the payout to ${p.bppId}`}
                    className="w-44 rounded-md border border-(--c-border) bg-white px-2 py-1 text-[12px] text-(--c-ink)"
                  />
                  <button
                    onClick={() => markPaid(p.id)}
                    disabled={busy !== null || (utr[p.id] ?? "").trim().length < 6}
                    className="rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                  >
                    Record as paid
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-(--c-muted)">
                No payouts waiting.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Refunds({ onNotice }: { onNotice: NoticeFn }) {
  const [rows, setRows] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ refunds: Refund[] }>("/api/console/admin/ondc/refunds")
      .then((d) => setRows(d.refunds))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function resolve(id: string, body: { paise: number } | { retry: true }, done: string) {
    setBusy(id);
    onNotice(null);
    try {
      await api(`/api/console/admin/ondc/orders/${id}/refund`, { method: "POST", json: body });
      onNotice({ kind: "ok", text: done });
      load();
    } catch (err) {
      onNotice({ kind: "error", text: message(err, "Nothing was changed.") });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-(--c-muted)">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-(--c-border)">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-white text-[12px] uppercase tracking-wide text-(--c-muted)">
          <tr>
            <th className="px-4 py-2.5 font-medium">Store</th>
            <th className="px-4 py-2.5 font-medium">Paid / final bill</th>
            <th className="px-4 py-2.5 font-medium">Refund</th>
            <th className="px-4 py-2.5 font-medium">Why it is here</th>
            <th className="px-4 py-2.5 font-medium text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-(--c-line)">
          {rows.map((r) => {
            const rupeesTyped = amount[r.id] ?? "";
            const typed = /^\d+(\.\d{1,2})?$/.test(rupeesTyped.trim()) ? Math.round(Number(rupeesTyped.trim()) * 100) : null;
            const tooMuch = typed !== null && r.paidPaise != null && typed > r.paidPaise;
            return (
              <tr key={r.id} className="align-top hover:bg-[#f7f1e6]">
                <td className="px-4 py-2.5 text-(--c-ink)">{r.storeName}</td>
                <td className="px-4 py-2.5 text-(--c-ink)">
                  {rupees(r.paidPaise)}
                  <p className="text-[12px] text-(--c-muted)">bill {rupees(r.totalPaise)}</p>
                </td>
                <td className="px-4 py-2.5 text-(--c-ink)">
                  {rupees(r.refundPaise)}
                  <p className="text-[12px] text-(--c-muted)">{r.refundStatus}</p>
                </td>
                <td className="max-w-[260px] px-4 py-2.5 text-[12px] text-(--c-muted)">{r.problem ?? "No reason recorded"}</td>
                <td className="px-4 py-2.5 text-right">
                  {r.refundStatus === "failed" ? (
                    <button
                      onClick={() => resolve(r.id, { retry: true }, "Sent the refund again.")}
                      disabled={busy !== null}
                      className="rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                    >
                      Send again
                    </button>
                  ) : r.refundStatus === "review" ? (
                    <div className="flex items-center justify-end gap-2">
                      <input
                        value={rupeesTyped}
                        onChange={(e) => setAmount((a) => ({ ...a, [r.id]: e.target.value }))}
                        placeholder="Refund in rupees"
                        inputMode="decimal"
                        aria-label={`Refund amount for ${r.storeName}`}
                        className="w-32 rounded-md border border-(--c-border) bg-white px-2 py-1 text-[12px] text-(--c-ink)"
                      />
                      <button
                        onClick={() => typed !== null && resolve(r.id, { paise: typed }, "Refund set; it goes to the gateway now.")}
                        disabled={busy !== null || typed === null || tooMuch}
                        title={tooMuch ? "More than the customer paid" : undefined}
                        className="rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                      >
                        Refund
                      </button>
                    </div>
                  ) : (
                    <span className="text-[12px] text-(--c-muted)">Check in Cashfree first</span>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-(--c-muted)">
                No refunds need attention.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
