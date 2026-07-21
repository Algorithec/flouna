"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { StatCard, PageTitle } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Table, Badge, Empty, rupees } from "@/components/console/ui";

type RefundItem = {
  paymentId: string;
  orderId: string;
  orderTitle: string;
  domain: string;
  amountPaise: number;
  method: string | null;
  user: { id: string; name: string; email: string };
  flaggedAt: string;
};

export default function RefundsPage() {
  const [queue, setQueue] = useState<RefundItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null); // paymentId with reason box open
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load() {
    api<{ refunds: RefundItem[] }>("/api/console/super/refunds")
      .then((d) => setQueue(d.refunds))
      .catch(() => setQueue([]))
      .finally(() => setLoaded(true));
  }
  useEffect(load, []);

  async function approve(paymentId: string) {
    setBusy(paymentId);
    setError(null);
    try {
      await api(`/api/console/super/refunds/${paymentId}/approve`, { method: "POST" });
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function reject(paymentId: string) {
    setBusy(paymentId);
    setError(null);
    try {
      await api(`/api/console/super/refunds/${paymentId}/reject`, {
        method: "POST",
        json: { reason },
      });
      setRejecting(null);
      setReason("");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <ConsolePage accept={["super_admin"]}>
      <PageTitle
        title="Refund approvals"
        subtitle="Admins flag refunds; only a super-admin settles them. Every decision is audited."
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label="Awaiting review"
          value={loaded ? queue.length : "—"}
          tone={queue.length > 0 ? "warn" : "good"}
        />
        <StatCard
          label="Value in queue"
          value={loaded ? rupees(queue.reduce((s, q) => s + q.amountPaise, 0)) : "—"}
        />
      </div>

      {error && (
        <div
          className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px]"
          style={{ background: "#f6e7e5", color: "var(--c-red)" }}
        >
          <AlertCircle size={15} /> {error}
        </div>
      )}

      <Card title="Queue (oldest first)">
        {queue.length === 0 ? (
          <Empty>{loaded ? "No refunds awaiting review." : "Loading…"}</Empty>
        ) : (
          <Table head={["Order", "Customer", "Amount", "Method", "Flagged", "Decision"]}>
            {queue.map((r) => (
              <tr key={r.paymentId} className="hover:bg-[#f7f1e6]">
                <td className="px-4 py-2.5">
                  <p className="font-medium" style={{ color: "var(--c-ink)" }}>{r.orderTitle}</p>
                  <p className="font-mono text-[10.5px]" style={{ color: "var(--c-muted)" }}>
                    {r.orderId}
                  </p>
                </td>
                <td className="px-4 py-2.5">
                  <p style={{ color: "var(--c-ink)" }}>{r.user.name}</p>
                  <p className="text-[11px]" style={{ color: "var(--c-muted)" }}>{r.user.email}</p>
                </td>
                <td className="c-serif px-4 py-2.5 text-[14px] font-bold" style={{ color: "var(--c-maroon)" }}>
                  {rupees(r.amountPaise)}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone="slate">{r.method?.toUpperCase() ?? "—"}</Badge>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5" style={{ color: "var(--c-muted)" }}>
                  {new Date(r.flaggedAt).toLocaleString("en-IN")}
                </td>
                <td className="px-4 py-2.5">
                  {rejecting === r.paymentId ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Reason for rejecting…"
                        className="c-input w-44 rounded-md px-2 py-1.5 text-[12px] outline-none"
                      />
                      <button
                        onClick={() => reject(r.paymentId)}
                        disabled={busy === r.paymentId || reason.trim().length < 3}
                        className="rounded-md px-2.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                        style={{ background: "var(--c-red)" }}
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => { setRejecting(null); setReason(""); }}
                        className="text-[12px]"
                        style={{ color: "var(--c-muted)" }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => approve(r.paymentId)}
                        disabled={busy === r.paymentId}
                        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                        style={{ background: "#1a7a4a" }}
                      >
                        <CheckCircle2 size={13} /> Approve
                      </button>
                      <button
                        onClick={() => setRejecting(r.paymentId)}
                        disabled={busy === r.paymentId}
                        className="inline-flex items-center gap-1 rounded-md bg-white px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                        style={{ border: "1px solid var(--c-border)", color: "var(--c-red)" }}
                      >
                        <XCircle size={13} /> Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <p className="mt-3 text-[11px]" style={{ color: "var(--c-muted)" }}>
        Approving marks the payment refunded in our records. The gateway refund call is wired in
        once Cashfree goes live — no real money moves in simulation.
      </p>
    </ConsolePage>
  );
}
