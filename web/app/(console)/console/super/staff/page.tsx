"use client";

import { useEffect, useState } from "react";
import { Loader2, Ban, RotateCcw, AlertCircle } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

type Operator = {
  id: string;
  name: string;
  email: string;
  role: string;
  suspended: boolean;
  createdAt: string;
};

const ROLES = ["user", "developer", "admin", "super_admin"];
const ROLE_LABEL: Record<string, string> = {
  user: "Remove access (user)",
  developer: "Developer",
  admin: "Admin",
  super_admin: "Super-admin",
};

export default function SuperStaffPage() {
  const state = useOperator(["super_admin"]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api<{ operators: Operator[] }>("/api/console/super/operators")
      .then((d) => setOperators(d.operators))
      .catch(() => setOperators([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (state.status === "ok") load();
  }, [state.status]);

  async function changeRole(op: Operator, role: string) {
    if (role === op.role) return;
    setBusy(op.id);
    setError(null);
    try {
      await api(`/api/console/super/operators/${op.id}/role`, {
        method: "PATCH",
        json: { role },
      });
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Change refused.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleSuspend(op: Operator) {
    setBusy(op.id);
    setError(null);
    try {
      await api(`/api/console/super/operators/${op.id}/suspend`, {
        method: "PATCH",
        json: { suspended: !op.suspended },
      });
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Change refused.");
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

  const me = state.operator;

  return (
    <ConsoleShell operator={me}>
      <PageTitle
        title="Staff & roles"
        subtitle="Grant or revoke operator access. Every change is audited."
      />

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#e4b7b0] bg-[#f6e7e5] px-3 py-2 text-[13px] text-(--c-red)">
          <AlertCircle size={15} /> {error}
        </div>
      )}

      <p className="mb-3 text-[12px] text-(--c-muted)">
        To add a new operator: have them sign up, then promote their account here.
      </p>

      <div className="overflow-hidden rounded-xl border border-(--c-border)">
        {loading ? (
          <div className="flex justify-center py-16 text-(--c-muted)">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white text-[12px] uppercase tracking-wide text-(--c-muted)">
              <tr>
                <th className="px-4 py-2.5 font-medium">Operator</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Suspend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-(--c-line)">
              {operators.map((op) => {
                const isSelf = op.id === me.id;
                return (
                  <tr key={op.id} className="hover:bg-[#f7f1e6]">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-(--c-ink)">
                        {op.name}
                        {isSelf && (
                          <span className="ml-2 text-[11px] text-[#1a7a4a]">you</span>
                        )}
                      </p>
                      <p className="text-[12px] text-(--c-muted)">{op.email}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <select
                        value={op.role}
                        disabled={busy === op.id || isSelf}
                        onChange={(e) => changeRole(op, e.target.value)}
                        className="rounded-md border border-(--c-border) bg-white px-2 py-1 text-[13px] text-(--c-ink) disabled:opacity-50"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2.5">
                      {op.suspended ? (
                        <span className="text-(--c-red)">Suspended</span>
                      ) : (
                        <span className="text-[#1a7a4a]">Active</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => toggleSuspend(op)}
                        disabled={busy === op.id || isSelf}
                        className="inline-flex items-center gap-1 rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-40"
                      >
                        {op.suspended ? (
                          <>
                            <RotateCcw size={12} /> Reinstate
                          </>
                        ) : (
                          <>
                            <Ban size={12} /> Suspend
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {operators.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-(--c-muted)">
                    No operators yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </ConsoleShell>
  );
}
