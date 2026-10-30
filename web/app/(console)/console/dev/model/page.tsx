"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Badge, BarRow, Empty, Table } from "@/components/console/ui";

// Which model reads chat messages, how often the chain falls back, and how the
// watcher model compares on real traffic before it is trusted with customers.

type ModelOps = {
  windowDays: number;
  config: {
    chain: string;
    mode: string;
    hybridRouting: boolean;
    watcher: string | null;
    selfHosted: { configured: boolean; model: string };
  };
  traffic: {
    answered: number;
    byProvider: { provider: string; count: number }[];
    fellBack: number;
    allFailed: number;
  };
  watcher: {
    readings: number;
    failed: number;
    agreed: number;
    agreementPct: number | null;
    latencyMs: { p50: number | null; p95: number | null };
    fields: { field: string; compared: number; agreementPct: number }[];
  };
};

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "No data");

export default function ModelOpsPage() {
  const [ops, setOps] = useState<ModelOps | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<ModelOps>("/api/console/dev/model").then(setOps).catch(() => setFailed(true));
  }, []);

  return (
    <ConsolePage accept={["developer", "super_admin"]}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-(--c-ink)">Model operations</h1>
        <p className="mt-1 text-[13px] text-(--c-muted)">
          Who reads chat messages, how often the chain falls back, and how the watcher compares. Last{" "}
          {ops?.windowDays ?? 7} days.
        </p>
      </div>

      {failed && <Empty>Could not load the model status.</Empty>}

      {ops && (
        <>
          <div className="mb-4 flex flex-wrap gap-2 text-[13px]">
            <span className="rounded-lg border border-(--c-border) bg-white px-3 py-1.5">
              <span className="text-(--c-muted)">Chain</span>{" "}
              <span className="font-mono text-(--c-ink)">{ops.config.chain}</span>
            </span>
            <span className="rounded-lg border border-(--c-border) bg-white px-3 py-1.5">
              <span className="text-(--c-muted)">Hybrid routing</span>{" "}
              {ops.config.hybridRouting ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
            </span>
            <span className="rounded-lg border border-(--c-border) bg-white px-3 py-1.5">
              <span className="text-(--c-muted)">Watcher</span>{" "}
              <span className="font-mono text-(--c-ink)">{ops.config.watcher ?? "none"}</span>
            </span>
            <span className="rounded-lg border border-(--c-border) bg-white px-3 py-1.5">
              <span className="text-(--c-muted)">Own model</span>{" "}
              {ops.config.selfHosted.configured ? (
                <span className="font-mono text-(--c-ink)">{ops.config.selfHosted.model}</span>
              ) : (
                <Badge>Not connected</Badge>
              )}
            </span>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Answers" value={ops.traffic.answered} />
            <StatCard
              label="Fell back"
              value={pct(ops.traffic.fellBack, ops.traffic.answered)}
              hint={`${ops.traffic.fellBack} answered by a later provider`}
              tone={ops.traffic.fellBack > 0 ? "warn" : "good"}
            />
            <StatCard
              label="All providers failed"
              value={ops.traffic.allFailed}
              hint="Answered by the rule engine"
              tone={ops.traffic.allFailed > 0 ? "bad" : "good"}
            />
            <StatCard
              label="Watcher agreement"
              value={ops.watcher.agreementPct == null ? "No data" : `${ops.watcher.agreementPct}%`}
              hint={`${ops.watcher.readings} readings, ${ops.watcher.failed} failed`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Answers by provider">
              {ops.traffic.byProvider.length === 0 ? (
                <Empty>No answers in this period.</Empty>
              ) : (
                <div className="py-2">
                  {ops.traffic.byProvider.map((p) => (
                    <BarRow
                      key={p.provider}
                      label={p.provider}
                      value={String(p.count)}
                      max={(p.count / ops.traffic.byProvider[0]!.count) * 100}
                      color="var(--c-maroon)"
                    />
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="Watcher, field by field"
              right={
                <span className="text-[11px] text-(--c-muted)">
                  p50 {ops.watcher.latencyMs.p50 ?? "n/a"} ms, p95 {ops.watcher.latencyMs.p95 ?? "n/a"} ms
                </span>
              }
            >
              {ops.watcher.fields.length === 0 ? (
                <Empty>No watcher readings in this period.</Empty>
              ) : (
                <Table head={["Field", "Compared", "Agreement"]}>
                  {ops.watcher.fields.map((f) => (
                    <tr key={f.field}>
                      <td className="px-4 py-2 font-mono">{f.field}</td>
                      <td className="px-4 py-2">{f.compared}</td>
                      <td className="px-4 py-2">
                        <Badge tone={f.agreementPct >= 95 ? "green" : f.agreementPct >= 80 ? "amber" : "red"}>
                          {f.agreementPct}%
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </ConsolePage>
  );
}
