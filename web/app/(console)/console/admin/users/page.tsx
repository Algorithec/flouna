"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Search, Ban, RotateCcw, BadgeCheck } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

type Row = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  emailVerified: boolean;
  plusActive: boolean;
  suspended: boolean;
  orderCount: number;
  createdAt: string;
};

export default function AdminUsersPage() {
  const state = useOperator(["admin", "super_admin"]);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two searches in quick succession need not come back in order, and the late
  // answer won: the table could be showing the results of a query the operator
  // had already replaced.
  const req = useRef(0);

  function load(query = q) {
    const seq = ++req.current;
    api<{ users: Row[]; total: number }>(
      `/api/console/admin/users?q=${encodeURIComponent(query)}`,
    )
      .then((d) => {
        if (seq !== req.current) return;
        setRows(d.users);
        setTotal(d.total);
      })
      .catch(() => {
        if (seq === req.current) setRows([]);
      })
      .finally(() => {
        if (seq === req.current) setLoading(false);
      });
  }

  useEffect(() => {
    if (state.status === "ok") load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  async function toggleSuspend(row: Row) {
    setBusy(row.id);
    setError(null);
    try {
      await api(`/api/console/admin/users/${row.id}/suspend`, {
        method: "PATCH",
        json: { suspended: !row.suspended },
      });
      setRows((rs) =>
        rs.map((r) => (r.id === row.id ? { ...r, suspended: !r.suspended } : r)),
      );
    } catch (err) {
      // The swallowed case was operator accounts, and the button is not even
      // rendered for those — so in practice this threw away every real
      // failure. The row stayed as it was and nothing said why, which on a
      // suspension is the difference between an account being shut and an
      // operator believing it was.
      setError(
        err instanceof ApiClientError
          ? `That account was not changed: ${err.message}`
          : "That account was not changed.",
      );
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
      <PageTitle title="Users" subtitle={`${total} accounts`} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
        className="mb-4 flex max-w-md items-center gap-2 rounded-lg border border-(--c-border) bg-white px-3"
      >
        <Search size={16} className="text-(--c-muted)" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, email or phone"
          className="h-10 flex-1 bg-transparent text-[14px] text-(--c-ink) outline-none placeholder:text-(--c-muted)"
        />
      </form>

      {error && (
        <p className="mb-3 flex items-center gap-2 rounded-lg bg-(--c-red)/10 px-3 py-2 text-[13px] text-(--c-red)">
          <AlertTriangle size={15} /> {error}
        </p>
      )}

      {/* overflow-x-auto on the table wrapper, not overflow-hidden: these
         tables are wider than a phone, and hidden overflow clipped the
         right-hand columns away instead of letting them scroll. The row
         actions live in those columns, so below lg the rows could be read
         and not used. */}
      {loading ? (
        <div className="flex justify-center py-16 text-(--c-muted)">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-(--c-border)">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white text-[12px] uppercase tracking-wide text-(--c-muted)">
              <tr>
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Orders</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-(--c-line)">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-[#f7f1e6]">
                  <td className="px-4 py-2.5">
                    <p className="flex items-center gap-1.5 font-medium text-(--c-ink)">
                      {r.name}
                      {r.emailVerified && (
                        <BadgeCheck size={13} className="text-[#1a7a4a]" />
                      )}
                    </p>
                    <p className="text-[12px] text-(--c-muted)">{r.email}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        r.role === "user"
                          ? "text-(--c-muted)"
                          : "font-medium text-(--c-gold)"
                      }
                    >
                      {r.role}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-(--c-ink)">{r.orderCount}</td>
                  <td className="px-4 py-2.5">
                    {r.suspended ? (
                      <span className="text-(--c-red)">Suspended</span>
                    ) : r.plusActive ? (
                      <span className="text-[#1a7a4a]">Plus</span>
                    ) : (
                      <span className="text-(--c-muted)">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.role === "user" ? (
                      <button
                        onClick={() => toggleSuspend(r)}
                        disabled={busy === r.id}
                        className="inline-flex items-center gap-1 rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                      >
                        {r.suspended ? (
                          <>
                            <RotateCcw size={12} /> Reinstate
                          </>
                        ) : (
                          <>
                            <Ban size={12} /> Suspend
                          </>
                        )}
                      </button>
                    ) : (
                      <span className="text-[12px] text-(--c-muted)">No data</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-(--c-muted)">
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
