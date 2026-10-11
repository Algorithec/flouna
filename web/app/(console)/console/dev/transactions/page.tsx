"use client";

import { useEffect, useRef, useState } from "react";
import { X, ArrowRightLeft, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { ConsolePage, Card, Table, Badge, Empty } from "@/components/console/ui";

type Txn = {
  id: string;
  txnId: string;
  action: string;
  domain: string;
  bppId: string | null;
  status: string;
  signed: boolean;
  latencyMs: number | null;
  simulated: boolean;
  createdAt: string;
  orderId: string | null;
};

type Detail = Txn & { request: string | null; response: string | null };

// Request actions vs their callbacks get different tones.
function actionTone(action: string) {
  return action.startsWith("on_") ? "purple" : "blue";
}

// Pretty-print, but never throw. This was `JSON.stringify(JSON.parse(x))`
// inline in the render, so an envelope that is not valid JSON took the whole
// console page down to the error boundary — on the one screen whose job is
// reading envelopes, and for exactly the envelope most worth reading, because
// a malformed body is usually what went wrong. The complaints screen already
// does this the safe way.
function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const ACTIONS = ["", "search", "on_search", "select", "confirm", "on_confirm", "status", "on_status"];

export default function TransactionsPage() {
  const [txns, setTxns] = useState<Txn[]>([]);
  const [meta, setMeta] = useState({ total: 0, mode: "", byAction: {} as Record<string, number> });
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Detail | null>(null);

  // Escape closes the drawer, as it does every other dialog in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Changing the action filter fires another request, and the two need not
  // come back in order: the late answer won, so the table could be listing
  // envelopes for an action the operator had already moved off.
  const req = useRef(0);
  useEffect(() => {
    const seq = ++req.current;
    api<{ transactions: Txn[]; total: number; mode: string; byAction: Record<string, number> }>(
      `/api/console/dev/transactions${filter ? `?action=${filter}` : ""}`,
    )
      .then((d) => {
        if (seq !== req.current) return;
        setTxns(d.transactions);
        setMeta({ total: d.total, mode: d.mode, byAction: d.byAction });
      })
      .catch(() => {
        if (seq === req.current) setTxns([]);
      });
  }, [filter]);

  function openDetail(id: string) {
    api<{ transaction: Detail }>(`/api/console/dev/transactions/${id}`)
      .then((d) => setOpen(d.transaction))
      .catch(() => {});
  }

  return (
    <ConsolePage accept={["developer", "super_admin"]}>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-(--c-ink)">ONDC transactions</h1>
          <p className="mt-1 text-[13px] text-(--c-muted)">
            Beckn request/callback envelopes per order journey.{" "}
            {meta.mode && meta.mode !== "ondc" && (
              <span className="text-(--c-gold)">Simulated until registration.</span>
            )}
          </p>
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[13px] text-(--c-ink)"
        >
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a === "" ? "All actions" : a}
            </option>
          ))}
        </select>
      </div>

      <Card title={`${meta.total} envelopes`}>
        {txns.length === 0 ? (
          <Empty>No transactions yet, place + pay an order to generate the flow.</Empty>
        ) : (
          <Table head={["Action", "Domain", "BPP", "Status", "Signed", "Latency", "When", ""]}>
            {txns.map((t) => (
              // The row was the only way in and only answered a mouse: there
              // was no keyboard route to any envelope on this screen.
              <tr
                key={t.id}
                tabIndex={0}
                role="button"
                aria-label={`Open ${t.action} envelope`}
                className="cursor-pointer hover:bg-[#f7f1e6] focus-visible:bg-[#f7f1e6]"
                onClick={() => openDetail(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDetail(t.id);
                  }
                }}
              >
                <td className="px-4 py-2.5">
                  <Badge tone={actionTone(t.action)}>{t.action}</Badge>
                </td>
                <td className="px-4 py-2.5 font-mono text-(--c-muted)">{t.domain}</td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-(--c-muted)">{t.bppId ?? "No data"}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={t.status === "ack" ? "green" : "red"}>{t.status}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  {t.signed ? <ShieldCheck size={14} className="text-[#1a7a4a]" /> : "No data"}
                </td>
                <td className="px-4 py-2.5 text-(--c-ink)">{t.latencyMs != null ? `${t.latencyMs} ms` : "No data"}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-(--c-muted)">
                  {new Date(t.createdAt).toLocaleTimeString("en-IN")}
                </td>
                <td className="px-4 py-2.5 text-right text-(--c-muted)">
                  <ArrowRightLeft size={13} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Envelope detail drawer */}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setOpen(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Transaction detail"
            className="h-full w-full max-w-xl overflow-y-auto border-l border-(--c-border) bg-white p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <Badge tone={actionTone(open.action)}>{open.action}</Badge>
                <p className="mt-2 font-mono text-[12px] text-(--c-muted)">txn {open.txnId}</p>
                {open.orderId && (
                  <p className="font-mono text-[11px] text-(--c-muted)">order {open.orderId}</p>
                )}
              </div>
              <button
                onClick={() => setOpen(null)}
                aria-label="Close"
                className="text-(--c-muted) hover:text-(--c-ink)"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mb-3 flex flex-wrap gap-2 text-[12px]">
              <span className="rounded bg-white px-2 py-1 text-(--c-muted)">
                domain <span className="font-mono text-(--c-ink)">{open.domain}</span>
              </span>
              <span className="rounded bg-white px-2 py-1 text-(--c-muted)">
                status <span className="font-mono text-[#1a7a4a]">{open.status}</span>
              </span>
              {open.signed && (
                <span className="rounded bg-[#e5f3ea] px-2 py-1 text-[#1a7a4a]">Ed25519 signed</span>
              )}
              {open.simulated && (
                <span className="rounded bg-[#fef3dc] px-2 py-1 text-(--c-gold)">simulated</span>
              )}
            </div>

            {open.request && (
              <div className="mb-4">
                <p className="mb-1 text-[12px] font-semibold text-(--c-muted)">Request envelope</p>
                <pre className="overflow-x-auto rounded-lg border border-(--c-border) bg-white p-3 text-[11px] leading-relaxed text-(--c-ink)">
                  {pretty(open.request)}
                </pre>
              </div>
            )}
            {open.response && (
              <div>
                <p className="mb-1 text-[12px] font-semibold text-(--c-muted)">Callback envelope</p>
                <pre className="overflow-x-auto rounded-lg border border-(--c-border) bg-white p-3 text-[11px] leading-relaxed text-(--c-ink)">
                  {pretty(open.response)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </ConsolePage>
  );
}
