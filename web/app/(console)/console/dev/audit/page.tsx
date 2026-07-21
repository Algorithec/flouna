"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

type AuditRow = {
  id: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  ip: string | null;
  createdAt: string;
};

export default function DevAuditPage() {
  const state = useOperator(["developer", "super_admin"]);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (state.status !== "ok") return;
    api<{ logs: AuditRow[] }>("/api/console/dev/audit?limit=100")
      .then((d) => setRows(d.logs))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [state.status]);

  if (state.status !== "ok") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-(--c-muted)">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <ConsoleShell operator={state.operator}>
      <PageTitle
        title="Audit log"
        subtitle="Append-only record of privileged actions. Most recent first."
      />

      {loading ? (
        <div className="flex justify-center py-16 text-(--c-muted)">
          <Loader2 className="animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-16 text-center text-[14px] text-(--c-muted)">
          No privileged actions recorded yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-(--c-border)">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white text-[12px] uppercase tracking-wide text-(--c-muted)">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Actor</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-(--c-line)">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-[#f7f1e6]">
                  <td className="whitespace-nowrap px-4 py-2.5 text-(--c-muted)">
                    {new Date(r.createdAt).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-[#1a7a4a]">{r.actorRole}</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-(--c-ink)">{r.action}</td>
                  <td className="px-4 py-2.5 text-(--c-ink)">{r.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
