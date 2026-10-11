"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, CheckCircle2, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

type Ticket = {
  id: string;
  category: string;
  subject: string;
  status: string;
  priority: string;
  orderId: string | null;
  assigneeId: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
};

const PRIORITY_TONE: Record<string, string> = {
  urgent: "text-(--c-red)",
  high: "text-(--c-gold)",
  normal: "text-(--c-muted)",
  low: "text-(--c-muted)",
};

export default function AdminSupportPage() {
  const state = useOperator(["admin", "super_admin"]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [filter, setFilter] = useState("open");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // A failed load used to be written in as an empty list, so the queue said
  // "No tickets (open)" when it had not managed to ask — and somebody reading
  // that walks away from a queue that is actually full.
  const [failed, setFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Changing the filter fires another request and the two need not come back
  // in order: the late answer won, so the list could be showing resolved
  // tickets under "Open".
  const req = useRef(0);

  function load() {
    const seq = ++req.current;
    api<{ tickets: Ticket[] }>(
      `/api/console/admin/tickets${filter ? `?status=${filter}` : ""}`,
    )
      .then((d) => {
        if (seq !== req.current) return;
        setTickets(d.tickets);
        setFailed(false);
      })
      .catch(() => {
        if (seq === req.current) setFailed(true);
      })
      .finally(() => {
        if (seq === req.current) setLoading(false);
      });
  }

  useEffect(() => {
    if (state.status === "ok") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, filter]);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setActionError(null);
    try {
      await api(`/api/console/admin/tickets/${id}`, { method: "PATCH", json: body });
      load();
    } catch (err) {
      // There was no catch at all, so a refused PATCH became an unhandled
      // rejection: the button went back to normal, the ticket had not moved,
      // and nothing on screen said so. Resolve looked like it worked.
      setActionError(err instanceof Error ? err.message : "That did not go through.");
    } finally {
      setBusy(null);
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
      <div className="flex items-center justify-between">
        <PageTitle title="Support queue" subtitle="Issue & grievance tickets." />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[13px] text-(--c-ink)"
        >
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {actionError && (
        <p className="mb-3 flex items-center gap-2 rounded-lg bg-(--c-red)/10 px-3 py-2 text-[13px] text-(--c-red)">
          <AlertTriangle size={15} /> {actionError}
        </p>
      )}

      {failed ? (
        <div className="rounded-xl border border-(--c-red)/40 bg-(--c-red)/5 p-4">
          <p className="flex items-center gap-2 text-[14px] font-bold text-(--c-red)">
            <AlertTriangle size={15} /> This queue could not be loaded
          </p>
          <p className="mt-1 text-[13px] text-(--c-muted)">
            Do not read this as an empty queue. Tickets may be waiting.
          </p>
          <button
            type="button"
            onClick={load}
            className="mt-3 rounded-lg border border-(--c-line) px-3 py-2 text-[13px] font-medium text-(--c-ink)"
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <div className="flex justify-center py-16 text-(--c-muted)">
          <Loader2 className="animate-spin" />
        </div>
      ) : tickets.length === 0 ? (
        <p className="py-16 text-center text-[14px] text-(--c-muted)">
          No tickets {filter && `(${filter})`}.
        </p>
      ) : (
        <div className="space-y-2">
          {tickets.map((t) => (
            <div
              key={t.id}
              className="rounded-xl border border-(--c-border) bg-white p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[14px] font-medium text-(--c-ink)">
                    {t.subject}
                    <span className={`text-[11px] uppercase ${PRIORITY_TONE[t.priority]}`}>
                      {t.priority}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[12px] text-(--c-muted)">
                    <span className="capitalize">{t.category}</span> · {t.user.email} ·{" "}
                    {new Date(t.createdAt).toLocaleDateString("en-IN")}
                    {t.orderId && <span> · order {t.orderId.slice(0, 8)}</span>}
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-(--c-ivory) px-2 py-1 text-[11px] capitalize text-(--c-ink)">
                  {t.status.replace(/_/g, " ")}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {!t.assigneeId && (
                  <button
                    onClick={() => patch(t.id, { assignToMe: true, status: "in_progress" })}
                    disabled={busy === t.id}
                    className="inline-flex items-center gap-1 rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                  >
                    <UserPlus size={12} /> Assign to me
                  </button>
                )}
                {t.status !== "resolved" && t.status !== "closed" && (
                  <button
                    onClick={() =>
                      patch(t.id, { status: "resolved", resolution: "Handled by support." })
                    }
                    disabled={busy === t.id}
                    className="inline-flex items-center gap-1 rounded-md border border-[#9fd8bc] bg-[#e5f3ea] px-2.5 py-1 text-[12px] text-[#1a7a4a] hover:bg-[#d8ecdf] disabled:opacity-50"
                  >
                    <CheckCircle2 size={12} /> Resolve
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </ConsoleShell>
  );
}
