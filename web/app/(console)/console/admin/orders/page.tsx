"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCcw } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

type Order = {
  id: string;
  domain: string;
  status: string;
  provider: string;
  title: string;
  amount: number;
  createdAt: string;
  user: { id: string; name: string; email: string };
  payment: { status: string; method: string | null } | null;
};

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

const STATUSES = ["", "confirmed", "in_progress", "completed", "cancelled"];

export default function AdminOrdersPage() {
  const state = useOperator(["admin", "super_admin"]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api<{ orders: Order[] }>(
      `/api/console/admin/orders${status ? `?status=${status}` : ""}`,
    )
      .then((d) => setOrders(d.orders))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (state.status === "ok") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, status]);

  async function flagRefund(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/console/admin/orders/${id}/flag-refund`, { method: "POST" });
      setOrders((os) =>
        os.map((o) =>
          o.id === id && o.payment
            ? { ...o, payment: { ...o.payment, status: "refund_pending" } }
            : o,
        ),
      );
    } catch (err) {
      // Was swallowed as "not refundable". It also swallowed a 500, a dropped
      // connection and the 409 from somebody else claiming the same payment:
      // the row went back to normal, nothing had been flagged, and the
      // operator who told a customer their refund was raised had no way to
      // know it was not. From here the super-admin queue never sees it.
      setError(
        err instanceof ApiClientError
          ? `Refund not flagged: ${err.message}`
          : "Refund not flagged. Nothing has been raised for this order.",
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
      <div className="flex items-center justify-between">
        <PageTitle title="Orders" />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[13px] text-(--c-ink)"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "" ? "All statuses" : s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

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
                <th className="px-4 py-2.5 font-medium">Order</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Amount</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Payment</th>
                <th className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-(--c-line)">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-[#f7f1e6]">
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-(--c-ink)">{o.title}</p>
                    <p className="text-[12px] capitalize text-(--c-muted)">
                      {o.domain} · {o.provider}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 text-(--c-muted)">{o.user.email}</td>
                  <td className="px-4 py-2.5 text-(--c-ink)">{rupees(o.amount)}</td>
                  <td className="px-4 py-2.5 capitalize text-(--c-ink)">
                    {o.status.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        o.payment?.status === "success"
                          ? "text-[#1a7a4a]"
                          : o.payment?.status === "refund_pending"
                            ? "text-(--c-gold)"
                            : "text-(--c-muted)"
                      }
                    >
                      {o.payment?.status ?? "No data"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {o.payment?.status === "success" ? (
                      <button
                        onClick={() => flagRefund(o.id)}
                        disabled={busy === o.id}
                        className="inline-flex items-center gap-1 rounded-md border border-(--c-border) px-2.5 py-1 text-[12px] text-(--c-ink) hover:bg-[#f0e8da] disabled:opacity-50"
                      >
                        <RefreshCcw size={12} /> Flag refund
                      </button>
                    ) : (
                      <span className="text-[12px] text-(--c-muted)">No data</span>
                    )}
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-(--c-muted)">
                    No orders.
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
