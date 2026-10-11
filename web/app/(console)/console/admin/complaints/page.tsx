"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { cn } from "@/lib/cn";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell } from "@/components/console/ConsoleShell";

// Operator view of ONDC IGM complaints.
//
// Built for the live walkthrough: ONDC's verifier should be able to point at
// anything the customer sees and find the record behind it. So the case, the
// action trail and the raw protocol messages sit on one screen, and the message
// log shows payloads verbatim rather than summarising them.
//
// The simulation controls stand in for a Seller NP we cannot reach yet. They
// drive the real action trail, not a mock — and the server refuses them in
// production, because something that can fabricate a resolution (and therefore
// a refund) must not exist on a live system.
type Row = {
  id: string;
  code: string;
  status: string;
  category: string;
  subCategory: string | null;
  orderId: string | null;
  escalationLevel: number;
  infoRequestedAt: string | null;
  createdAt: string;
  ondcIssueId: string | null;
  user: { name: string; email: string };
  _count: { actions: number; messages: number; resolutions: number };
};

type Detail = Row & {
  description: string;
  itemIds: string[];
  actors: { actorId: string; actorType: string; name: string | null }[];
  actions: {
    id: string;
    actionId: string;
    code: string;
    description: string;
    actionBy: string;
    lastActionId: string | null;
    createdAt: string;
  }[];
  messages: {
    id: string;
    direction: string;
    action: string;
    messageId: string | null;
    payload: string;
    status: string;
    error: string | null;
    createdAt: string;
  }[];
  resolutions: {
    id: string;
    resolutionId: string;
    itemId: string | null;
    type: string;
    amountPaise: number | null;
    description: string;
    customerDecision: string | null;
  }[];
  refunds: {
    amountPaise: number;
    status: string;
    refundReference: string | null;
    completedAt: string | null;
  }[];
  escalations: { level: number; reason: string; targetActor: string }[];
  evidence: { id: string; mimeType: string; sizeBytes: number }[];
};

const STATUS_TONE: Record<string, string> = {
  OPEN: "bg-amber-100 text-amber-800",
  PROCESSING: "bg-blue-100 text-blue-800",
  RESOLVED: "bg-green-100 text-green-800",
  CLOSED: "bg-neutral-200 text-neutral-700",
};

// Every other console screen is wrapped in the operator gate and the console
// chrome; this one was not. Reached from the sidebar it dropped the operator
// onto a page with no sidebar and no mobile header, so the only way to any
// other console screen was the browser's back button. Signed out it rendered
// the whole screen and showed "Failed to load" instead of sending them to the
// console login. The server always re-authorized the calls, so this was
// navigation and a misleading error, not access.
export default function AdminComplaintsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center text-(--c-muted)">
          <Loader2 className="animate-spin" />
        </div>
      }
    >
      <Complaints />
    </Suspense>
  );
}

function Complaints() {
  const state = useOperator(["admin", "super_admin"]);
  // "Protocol log" on a grievance links here with ?case=<id>. The parameter was
  // read by nothing, so the operator chasing one case landed on the unfiltered
  // list and had to find it again by eye.
  const caseId = useSearchParams().get("case");
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(caseId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.status !== "ok") return;
    let cancelled = false;
    api<{ complaints: Row[] }>("/api/console/admin/complaints")
      .then((d) => {
        if (!cancelled) setRows(d.complaints);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [state.status]);

  useEffect(() => {
    if (!selected || state.status !== "ok") return;
    let cancelled = false;
    api<{ complaint: Detail }>(`/api/console/admin/complaints/${selected}`)
      .then((d) => {
        if (!cancelled) setDetail(d.complaint);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected, state.status]);

  async function refresh() {
    if (!selected) return;
    const d = await api<{ complaint: Detail }>(
      `/api/console/admin/complaints/${selected}`,
    );
    setDetail(d.complaint);
  }

  async function simulate(step: string) {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/console/admin/complaints/${selected}/simulate/${step}`, {
        method: "POST",
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }

  if (state.status !== "ok") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-(--c-muted)">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <ConsoleShell operator={state.operator}>
      <h1 className="text-[24px] font-bold text-ink">ONDC IGM complaints</h1>
      <p className="mt-1 max-w-[70ch] text-[14px] text-cocoa">
        Every customer-facing event has a record here. The message log shows the
        ONDC traffic verbatim, that pairing is what the live walkthrough asks
        to see.
      </p>

      {error && <p className="mt-4 text-[14px] text-danger">{error}</p>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* List */}
        <div className="overflow-hidden rounded-[14px] border border-line bg-card">
          {rows.length === 0 && (
            <p className="p-4 text-[14px] text-cocoa">No complaints yet.</p>
          )}
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={cn(
                "flex w-full flex-col gap-1 border-b border-line px-4 py-3 text-left last:border-b-0 transition-colors",
                selected === r.id ? "bg-accent-soft/50" : "hover:bg-beige/40",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-mono text-[13px] font-bold text-ink">
                  {r.code}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-bold",
                    STATUS_TONE[r.status] ?? "bg-neutral-200 text-neutral-700",
                  )}
                >
                  {r.status}
                </span>
              </span>
              <span className="truncate text-[13px] text-ink">
                {r.subCategory ?? r.category}
              </span>
              <span className="truncate text-[12px] text-cocoa">
                {r.user.name} · {r.user.email}
              </span>
              <span className="text-[11px] text-muted">
                {r._count.actions} actions · {r._count.messages} messages
                {r.escalationLevel > 0 && ` · escalated L${r.escalationLevel}`}
              </span>
            </button>
          ))}
        </div>

        {/* Detail */}
        <div className="min-w-0">
          {!detail && (
            <p className="rounded-[14px] border border-line bg-card p-6 text-[14px] text-cocoa">
              Select a complaint to see its record, action trail and ONDC
              messages.
            </p>
          )}

          {detail && (
            <div className="flex flex-col gap-5">
              {/* Case */}
              <section className="rounded-[14px] border border-line bg-card p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="font-mono text-[18px] font-bold text-ink">
                    {detail.code}
                  </h2>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] font-bold",
                      STATUS_TONE[detail.status],
                    )}
                  >
                    {detail.status}
                  </span>
                  {detail.ondcIssueId ? (
                    <span className="font-mono text-[12px] text-cocoa">
                      issue {detail.ondcIssueId}
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                      not yet transmitted
                    </span>
                  )}
                </div>
                <p className="mt-3 text-[14px] text-ink">{detail.description}</p>
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-3">
                  <Pair k="Category" v={`${detail.category}${detail.subCategory ? ` / ${detail.subCategory}` : ""}`} />
                  <Pair k="Order" v={detail.orderId ?? "No data"} mono />
                  <Pair k="Customer" v={detail.user.email} />
                  <Pair k="Raised" v={new Date(detail.createdAt).toLocaleString()} />
                  <Pair k="Escalation" v={detail.escalationLevel === 0 ? "none" : `level ${detail.escalationLevel}`} />
                  <Pair k="Evidence" v={`${detail.evidence.length} file(s)`} />
                </dl>
                <p className="mt-3 text-[12px] text-cocoa">
                  Actors:{" "}
                  {detail.actors.map((a) => `${a.actorType} (${a.actorId})`).join(" · ")}
                </p>
              </section>

              {/* Walkthrough rehearsal */}
              <section className="rounded-[14px] border border-amber-300 bg-amber-50 p-5">
                <h3 className="text-[14px] font-bold text-amber-900">
                  Seller simulation, rehearsal only
                </h3>
                <p className="mt-1 text-[13px] text-amber-900/80">
                  Stands in for a Seller NP until the ONDC integration is live.
                  These drive the real action trail, and the server refuses them
                  in production.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    ["acknowledge", "Acknowledge"],
                    ["request-info", "Request information"],
                    ["propose", "Propose 2 resolutions"],
                    ["complete-refund", "Mark refund completed"],
                  ].map(([step, label]) => (
                    <button
                      key={step}
                      disabled={busy}
                      onClick={() => simulate(step)}
                      className="rounded-pill border border-amber-400 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-50"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </section>

              {/* Action trail */}
              <section className="rounded-[14px] border border-line bg-card p-5">
                <h3 className="text-[14px] font-bold text-ink">
                  Action trail ({detail.actions.length})
                </h3>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-[12px]">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                        <th className="py-1.5 pr-3">Code</th>
                        <th className="py-1.5 pr-3">Description</th>
                        <th className="py-1.5 pr-3">By</th>
                        <th className="py-1.5 pr-3">Action ID</th>
                        <th className="py-1.5 pr-3">Prev</th>
                        <th className="py-1.5">At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.actions.map((a) => (
                        <tr key={a.id} className="border-t border-line/70">
                          <td className="py-1.5 pr-3 font-semibold text-ink">{a.code}</td>
                          <td className="py-1.5 pr-3 text-cocoa">{a.description}</td>
                          <td className="py-1.5 pr-3 text-cocoa">{a.actionBy}</td>
                          <td className="py-1.5 pr-3 font-mono text-[11px] text-muted">{a.actionId}</td>
                          <td className="py-1.5 pr-3 font-mono text-[11px] text-muted">{a.lastActionId ?? "No data"}</td>
                          <td className="py-1.5 whitespace-nowrap text-cocoa">
                            {new Date(a.createdAt).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Resolutions + refunds */}
              {(detail.resolutions.length > 0 || detail.refunds.length > 0) && (
                <section className="rounded-[14px] border border-line bg-card p-5">
                  <h3 className="text-[14px] font-bold text-ink">
                    Resolutions &amp; refunds
                  </h3>
                  <ul className="mt-2 flex flex-col gap-1.5 text-[13px]">
                    {detail.resolutions.map((r) => (
                      <li key={r.id} className="flex flex-wrap gap-x-2 text-cocoa">
                        <span className="font-semibold text-ink">{r.type}</span>
                        {r.amountPaise != null && <span>{rupees(r.amountPaise)}</span>}
                        {r.itemId && <span>· item {r.itemId}</span>}
                        <span>· {r.description}</span>
                        <span className="font-semibold">
                          · {r.customerDecision ?? "awaiting customer"}
                        </span>
                      </li>
                    ))}
                    {detail.refunds.map((r, i) => (
                      <li key={i} className="flex flex-wrap gap-x-2 text-cocoa">
                        <span className="font-semibold text-ink">REFUND</span>
                        <span>{rupees(r.amountPaise)}</span>
                        <span>· {r.status}</span>
                        <span>· ref {r.refundReference ?? "none yet"}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Protocol log — verbatim, for the verifier */}
              <section className="rounded-[14px] border border-line bg-card p-5">
                <h3 className="text-[14px] font-bold text-ink">
                  ONDC message log ({detail.messages.length})
                </h3>
                {detail.messages.length === 0 && (
                  <p className="mt-2 text-[13px] text-cocoa">
                    No protocol traffic yet.
                  </p>
                )}
                <div className="mt-3 flex flex-col gap-3">
                  {detail.messages.map((m) => (
                    <div key={m.id} className="rounded-[10px] border border-line bg-cream/60 p-3">
                      <p className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 font-bold",
                            m.direction === "outbound"
                              ? "bg-blue-100 text-blue-800"
                              : "bg-green-100 text-green-800",
                          )}
                        >
                          {m.direction}
                        </span>
                        <span className="font-mono font-semibold text-ink">{m.action}</span>
                        <span className="text-cocoa">· {m.status}</span>
                        {m.messageId && (
                          <span className="font-mono text-[11px] text-muted">
                            · {m.messageId}
                          </span>
                        )}
                        <span className="text-[11px] text-muted">
                          · {new Date(m.createdAt).toLocaleString()}
                        </span>
                      </p>
                      {m.error && (
                        <p className="mt-1 text-[12px] text-amber-800">{m.error}</p>
                      )}
                      <pre className="mt-2 max-h-52 overflow-auto rounded bg-ink/90 p-2.5 text-[11px] leading-relaxed text-cream">
                        {(() => {
                          try {
                            return JSON.stringify(JSON.parse(m.payload), null, 2);
                          } catch {
                            return m.payload;
                          }
                        })()}
                      </pre>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </ConsoleShell>
  );
}

function Pair({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{k}</dt>
      <dd className={cn("truncate text-ink", mono && "font-mono text-[12px]")}>{v}</dd>
    </div>
  );
}
