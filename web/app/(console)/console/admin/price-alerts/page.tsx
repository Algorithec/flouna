"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Table, Badge, Empty, rupees } from "@/components/console/ui";

type Alert = {
  id: string;
  domain: string;
  itemName: string;
  targetPaise: number;
  lastSeenPaise: number;
  active: boolean;
  triggeredAt: string | null;
};

export default function PriceAlertsPage() {
  const [recent, setRecent] = useState<Alert[]>([]);
  const [meta, setMeta] = useState({ active: 0, triggered: 0, total: 0 });

  useEffect(() => {
    api<{ active: number; triggered: number; total: number; recent: Alert[] }>(
      "/api/console/admin/price-alerts",
    )
      .then((d) => {
        setRecent(d.recent);
        setMeta({ active: d.active, triggered: d.triggered, total: d.total });
      })
      .catch(() => {});
  }, []);

  return (
    <ConsolePage accept={["admin", "super_admin"]}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-(--c-ink)">Price alerts</h1>
        <p className="mt-1 text-[13px] text-(--c-muted)">
          AI-tracked price-drop watches set by real users.
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Active watches" value={meta.active} tone="warn" />
        <StatCard label="Triggered" value={meta.triggered} tone="good" />
        <StatCard label="Total ever" value={meta.total} />
      </div>

      <Card title="Recent alerts">
        {recent.length === 0 ? (
          <Empty>No price alerts set yet.</Empty>
        ) : (
          <Table head={["Item", "Domain", "Target", "Last seen", "Status"]}>
            {recent.map((a) => (
              <tr key={a.id} className="hover:bg-[#f7f1e6]">
                <td className="px-4 py-2.5 font-medium text-(--c-ink)">{a.itemName}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={a.domain === "food" ? "amber" : "blue"}>{a.domain}</Badge>
                </td>
                <td className="px-4 py-2.5 text-[#1a7a4a]">{rupees(a.targetPaise)}</td>
                <td className="px-4 py-2.5 text-(--c-ink)">{rupees(a.lastSeenPaise)}</td>
                <td className="px-4 py-2.5">
                  {a.triggeredAt ? (
                    <Badge tone="green">Triggered</Badge>
                  ) : a.active ? (
                    <Badge tone="blue">Watching</Badge>
                  ) : (
                    <Badge tone="slate">Inactive</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </ConsolePage>
  );
}
