"use client";

import { useEffect, useState } from "react";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

type AuditRow = {
  id: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  ip: string | null;
  createdAt: string;
};

export default function SuperAuditPage() {
  const state = useOperator(["super_admin"]);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (state.status !== "ok") return;
    api<{ logs: AuditRow[]; total: number }>(`/api/console/super/audit?page=${page}`)
      .then((d) => {
        setRows(d.logs);
        setTotal(d.total);
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [state.status, page]);

  if (state.status !== "ok") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-(--c-muted)">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <ConsoleShell operator={state.operator}>
      <PageTitle
        title="Audit trail"
        subtitle={`${total} recorded actions — append-only.`}
      />

      <div className="overflow-hidden rounded-xl border border-(--c-border)">
        {loading ? (
          <div className="flex justify-center py-16 text-(--c-muted)">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white text-[12px] uppercase tracking-wide text-(--c-muted)">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Actor</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Summary</th>
                <th className="px-4 py-2.5 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-(--c-line)">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-[#f7f1e6]">
                  <td className="whitespace-nowrap px-4 py-2.5 text-(--c-muted)">
                    {new Date(r.createdAt).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-2.5 text-[#1a7a4a]">{r.actorRole}</td>
                  <td className="px-4 py-2.5 font-mono text-(--c-ink)">{r.action}</td>
                  <td className="px-4 py-2.5 text-(--c-ink)">{r.summary}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-(--c-muted)">
                    {r.ip ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-[13px] text-(--c-muted)">
        <span>
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex items-center gap-1 rounded-md border border-(--c-border) px-2.5 py-1 disabled:opacity-40"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={page >= pages}
            className="flex items-center gap-1 rounded-md border border-(--c-border) px-2.5 py-1 disabled:opacity-40"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </ConsoleShell>
  );
}
