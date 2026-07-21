"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Clock, Info, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Empty } from "@/components/console/ui";

type Alert = {
  severity: "critical" | "warning" | "info" | "resolved";
  source: string;
  message: string;
  at: string;
};

const ICON = {
  critical: <AlertCircle size={15} className="text-(--c-red)" />,
  warning: <Clock size={15} className="text-(--c-gold)" />,
  info: <Info size={15} className="text-[#2e6db4]" />,
  resolved: <CheckCircle2 size={15} className="text-[#1a7a4a]" />,
};

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [counts, setCounts] = useState({ critical: 0, warning: 0 });

  useEffect(() => {
    api<{ alerts: Alert[]; counts: { critical: number; warning: number } }>(
      "/api/console/dev/alerts",
    )
      .then((d) => {
        setAlerts(d.alerts);
        setCounts(d.counts);
      })
      .catch(() => {});
  }, []);

  return (
    <ConsolePage accept={["developer", "super_admin"]}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-(--c-ink)">Alerts &amp; exceptions</h1>
        <p className="mt-1 text-[13px] text-(--c-muted)">
          Real, derived from server errors, pending refunds and urgent tickets.
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Critical" value={counts.critical} tone={counts.critical ? "bad" : "good"} />
        <StatCard label="Warnings" value={counts.warning} tone={counts.warning ? "warn" : "good"} />
        <StatCard label="Total active" value={alerts.length} />
      </div>

      <Card title="Alert feed">
        {alerts.length === 0 ? (
          <Empty>All clear — no active alerts.</Empty>
        ) : (
          <ul className="divide-y divide-(--c-line)">
            {alerts.map((a, i) => (
              <li key={i} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5">{ICON[a.severity]}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-(--c-ink)">{a.message}</p>
                  <p className="mt-0.5 text-[11px] text-(--c-muted)">
                    {a.source} · {new Date(a.at).toLocaleString("en-IN")}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </ConsolePage>
  );
}
