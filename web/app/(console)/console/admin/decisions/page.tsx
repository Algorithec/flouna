"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ConsolePage, Card, Table, Badge, Empty } from "@/components/console/ui";

type Log = { time: string; intent: string; domain: string };

const TONE: Record<string, "amber" | "blue" | "purple" | "green" | "red" | "slate"> = {
  food: "amber",
  ride: "blue",
  shop: "purple",
  combo: "green",
};

export default function DecisionsPage() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    api<{ logs: Log[]; total: number }>("/api/console/admin/decisions")
      .then((d) => {
        setLogs(d.logs);
        setTotal(d.total);
      })
      .catch(() => {});
  }, []);

  return (
    <ConsolePage accept={["admin", "super_admin"]}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-(--c-ink)">Decision logs</h1>
        <p className="mt-1 text-[13px] text-(--c-muted)">
          {total} real AI decisions — the user intent and the domain it resolved to.
        </p>
      </div>

      <Card title="Recent decisions">
        {logs.length === 0 ? (
          <Empty>No decisions logged yet — chat with the assistant to populate this.</Empty>
        ) : (
          <Table head={["Time", "User intent", "Domain"]}>
            {logs.map((l, i) => (
              <tr key={i} className="hover:bg-[#f7f1e6]">
                <td className="whitespace-nowrap px-4 py-2.5 text-(--c-muted)">
                  {new Date(l.time).toLocaleString("en-IN")}
                </td>
                <td className="px-4 py-2.5 text-(--c-ink)">&ldquo;{l.intent}&rdquo;</td>
                <td className="px-4 py-2.5">
                  <Badge tone={TONE[l.domain] ?? "slate"}>{l.domain}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </ConsolePage>
  );
}
