"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import {
  ConsoleShell,
  PageTitle,
  StatCard,
} from "@/components/console/ConsoleShell";

type Health = {
  ok: boolean;
  db: string;
  dbLatencyMs: number;
  uptimeSeconds: number;
  node: string;
  env: string;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  loadAvg: number[];
};

type Providers = {
  llm: { active: string; mode: string };
  integrations: Record<string, boolean>;
  fulfilment: { mode: string };
};

function uptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function DevHomePage() {
  const state = useOperator(["developer", "super_admin"]);
  const [health, setHealth] = useState<Health | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [openErrors, setOpenErrors] = useState<number | null>(null);

  useEffect(() => {
    if (state.status !== "ok") return;
    api<Health>("/api/console/dev/health").then(setHealth).catch(() => {});
    api<Providers>("/api/console/dev/providers").then(setProviders).catch(() => {});
    api<{ openCount: number }>("/api/console/dev/errors")
      .then((d) => setOpenErrors(d.openCount))
      .catch(() => {});
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
        title="Diagnostics"
        subtitle="System health, integrations and live runtime — read-only."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="API"
          value={health?.ok ? "Healthy" : "Down"}
          tone={health?.ok ? "good" : "bad"}
          hint={health ? `${health.env} · Node ${health.node}` : undefined}
        />
        <StatCard
          label="Database"
          value={health ? `${health.dbLatencyMs} ms` : "—"}
          tone={health?.db === "ok" ? "good" : "bad"}
          hint={health?.db === "ok" ? "reachable" : "unreachable"}
        />
        <StatCard
          label="Uptime"
          value={health ? uptime(health.uptimeSeconds) : "—"}
        />
        <StatCard
          label="Open errors"
          value={openErrors ?? "—"}
          tone={openErrors && openErrors > 0 ? "warn" : "good"}
          hint="unresolved fingerprints"
        />
      </div>

      {health && (
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="RSS memory" value={`${health.memory.rssMb} MB`} />
          <StatCard
            label="Heap used"
            value={`${health.memory.heapUsedMb} / ${health.memory.heapTotalMb} MB`}
          />
          <StatCard
            label="Load avg (1m)"
            value={health.loadAvg[0] ?? 0}
          />
          <StatCard
            label="Fulfilment"
            value={providers?.fulfilment.mode ?? "—"}
            hint="simulation until ONDC live"
          />
        </div>
      )}

      {providers && (
        <div className="mt-8">
          <h2 className="mb-3 text-[14px] font-semibold text-(--c-ink)">
            Integrations
          </h2>
          <div className="rounded-xl border border-(--c-border) bg-white p-2">
            <div className="mb-2 flex items-center justify-between rounded-lg bg-(--c-ivory) px-3 py-2 text-[13px]">
              <span className="text-(--c-ink)">LLM provider</span>
              <span className="font-mono text-[#1a7a4a]">
                {providers.llm.active} ({providers.llm.mode})
              </span>
            </div>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1 px-3 py-2 lg:grid-cols-3">
              {Object.entries(providers.integrations).map(([key, on]) => (
                <li
                  key={key}
                  className="flex items-center justify-between py-1 text-[13px]"
                >
                  <span className="capitalize text-(--c-muted)">
                    {key.replace(/_/g, " ")}
                  </span>
                  <span
                    className={on ? "text-[#1a7a4a]" : "text-(--c-muted)"}
                  >
                    {on ? "configured" : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </ConsoleShell>
  );
}
