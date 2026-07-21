"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, RotateCcw, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

type ErrorRow = {
  id: string;
  name: string;
  message: string;
  stack: string | null;
  route: string | null;
  statusCode: number | null;
  count: number;
  resolved: boolean;
  firstSeen: string;
  lastSeen: string;
};

export default function DevErrorsPage() {
  const state = useOperator(["developer", "super_admin"]);
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  function load() {
    api<{ errors: ErrorRow[] }>(
      `/api/console/dev/errors?resolved=${showResolved}`,
    )
      .then((d) => setRows(d.errors))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }

  // Reload whenever the operator is authorized or the resolved filter changes.
  useEffect(() => {
    if (state.status === "ok") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, showResolved]);

  async function toggleResolved(row: ErrorRow) {
    await api(`/api/console/dev/errors/${row.id}/resolve`, {
      method: "PATCH",
      json: { resolved: !row.resolved },
    }).catch(() => {});
    load();
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
        <PageTitle
          title="Error log"
          subtitle="Every captured server error, grouped by signature."
        />
        <label className="flex items-center gap-2 text-[13px] text-(--c-muted)">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="accent-(--c-maroon)"
          />
          Show resolved
        </label>
      </div>

      {loading ? (
        <div className="flex justify-center py-16 text-(--c-muted)">
          <Loader2 className="animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-(--c-muted)">
          <CheckCircle2 className="text-[#1a7a4a]" />
          <p className="text-[14px]">No {showResolved ? "" : "open "}errors. All clear.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="rounded-xl border border-(--c-border) bg-white"
            >
              <div className="flex items-start gap-3 p-4">
                <AlertTriangle
                  size={16}
                  className={row.resolved ? "mt-0.5 text-(--c-muted)" : "mt-0.5 text-(--c-red)"}
                />
                <button
                  onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="flex items-center gap-2 text-[14px] font-medium text-(--c-ink)">
                    <span className="font-mono text-(--c-red)">{row.name}</span>
                    <span className="truncate">{row.message}</span>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-(--c-muted)">
                    {row.route && <span className="font-mono">{row.route}</span>}
                    <span>×{row.count}</span>
                    <span>last {new Date(row.lastSeen).toLocaleString("en-IN")}</span>
                  </p>
                </button>
                <button
                  onClick={() => toggleResolved(row)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da]"
                >
                  {row.resolved ? (
                    <>
                      <RotateCcw size={12} /> Reopen
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={12} /> Resolve
                    </>
                  )}
                </button>
              </div>
              {expanded === row.id && row.stack && (
                <pre className="overflow-x-auto border-t border-(--c-border) bg-white p-4 text-[11px] leading-relaxed text-(--c-muted)">
                  {row.stack}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </ConsoleShell>
  );
}
