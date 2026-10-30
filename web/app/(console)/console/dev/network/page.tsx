"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Badge, Empty, Table } from "@/components/console/ui";

// The ONDC connection as it stands: configuration (keys and tokens only as set
// or not set), callback traffic from seller apps, the observability log queue,
// and where orders, rides and settlements are.

type Counts = { status: string; count: number }[];

type Network = {
  mode: string;
  domains: { domain: string; status: string }[];
  ops: {
    windowDays: number;
    config: {
      providerMode: string;
      registry: string;
      subscriberId: string | null;
      callbackActions: number;
      keys: { uniqueKeyId: boolean; signing: boolean; encryption: boolean };
      observabilityTokens: { retail: boolean; ride: boolean };
      searchEnabled: boolean;
      staticTerms: { url: string; effectiveDate: string } | null;
      finderFeePercent: number | null;
      foodCollectedBy: string | null;
      settlementAccount: boolean;
      gstin: boolean;
      unconfirmed: string[];
    };
    callbacks: {
      lastDay: number;
      simulated: number;
      byAction: { action: string; ack: number; nack: number; error: number }[];
    };
    observability: {
      pending: number;
      failing: number;
      sentToday: number;
      lastFailure: { domain: string; type: string; attempts: number; lastError: string | null; createdAt: string } | null;
    };
    orders: Counts;
    waiting: { id: string; status: string; store: string; bppId: string; waitingMinutes: number; paidPaise: number | null }[];
    rides: Counts;
    settlements: Counts;
  };
};

const WAITING_FOR: Record<string, string> = {
  selecting: "a quote",
  initialising: "final terms",
  confirming: "confirmation",
  cancelling: "a cancellation answer",
};

function setBadge(ok: boolean, yes = "Set", no = "Not set") {
  return ok ? <Badge tone="green">{yes}</Badge> : <Badge tone="red">{no}</Badge>;
}

function domainBadge(status: string) {
  if (status === "online") return <Badge tone="green">Online</Badge>;
  if (status === "simulated") return <Badge tone="amber">Simulated</Badge>;
  return <Badge tone="slate">Planned</Badge>;
}

function CountList({ rows, empty }: { rows: Counts; empty: string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y divide-(--c-line)">
      {rows.map((r) => (
        <li key={r.status} className="flex items-center justify-between px-4 py-2 text-[13px]">
          <span className="font-mono text-(--c-ink)">{r.status}</span>
          <span className="font-semibold text-(--c-ink)">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

export default function NetworkPage() {
  const [net, setNet] = useState<Network | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<Network>("/api/console/dev/network").then(setNet).catch(() => setFailed(true));
  }, []);

  const ops = net?.ops;
  const rows: [string, React.ReactNode][] = ops
    ? [
        ["Mode", <span key="m" className="font-mono">{ops.config.providerMode}</span>],
        ["Registry", <span key="r" className="font-mono">{ops.config.registry}</span>],
        ["Subscriber ID", <span key="s" className="font-mono">{ops.config.subscriberId ?? "not set"}</span>],
        ["Unique key ID", setBadge(ops.config.keys.uniqueKeyId)],
        ["Signing key", setBadge(ops.config.keys.signing)],
        ["Encryption key", setBadge(ops.config.keys.encryption)],
        ["Observability token, retail", setBadge(ops.config.observabilityTokens.retail)],
        ["Observability token, ride", setBadge(ops.config.observabilityTokens.ride)],
        ["Search ONDC sellers for everyone", setBadge(ops.config.searchEnabled, "On", "Off")],
        [
          "Static terms",
          ops.config.staticTerms ? (
            <a key="t" href={ops.config.staticTerms.url} target="_blank" rel="noreferrer" className="underline">
              from {ops.config.staticTerms.effectiveDate.slice(0, 10)}
            </a>
          ) : (
            <Badge tone="red">Not stated</Badge>
          ),
        ],
        ["Finder fee", <span key="f">{ops.config.finderFeePercent ?? "n/a"}%</span>],
        ["Food payment collected by", <span key="c" className="font-mono">{ops.config.foodCollectedBy ?? "n/a"}</span>],
        ["Settlement account", setBadge(ops.config.settlementAccount)],
        ["GSTIN", setBadge(ops.config.gstin)],
      ]
    : [];

  return (
    <ConsolePage accept={["developer", "super_admin"]}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-(--c-ink)">ONDC operations</h1>
        <p className="mt-1 text-[13px] text-(--c-muted)">
          Configuration, seller app callbacks, the observability log queue, and where orders stand. Keys and tokens
          are shown only as set or not set.
        </p>
      </div>

      {failed && <Empty>Could not load the ONDC status.</Empty>}

      {net && ops && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Callbacks, last day" value={ops.callbacks.lastDay} hint={`${ops.callbacks.simulated} simulated this week`} />
            <StatCard
              label="Logs waiting"
              value={ops.observability.pending}
              hint={`${ops.observability.failing} failing`}
              tone={ops.observability.failing > 0 ? "bad" : ops.observability.pending > 0 ? "warn" : "good"}
            />
            <StatCard label="Logs sent today" value={ops.observability.sentToday} />
            <StatCard
              label="Open decisions"
              value={ops.config.unconfirmed.length}
              tone={ops.config.unconfirmed.length > 0 ? "warn" : "good"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Configuration">
              <ul className="divide-y divide-(--c-line)">
                {rows.map(([label, value]) => (
                  <li key={label} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
                    <span className="text-(--c-muted)">{label}</span>
                    <span className="text-right text-(--c-ink)">{value}</span>
                  </li>
                ))}
              </ul>
            </Card>

            <div className="grid gap-4">
              <Card title="Open decisions">
                {ops.config.unconfirmed.length === 0 ? (
                  <Empty>None.</Empty>
                ) : (
                  <ul className="divide-y divide-(--c-line)">
                    {ops.config.unconfirmed.map((u) => (
                      <li key={u} className="px-4 py-2 text-[12px] text-(--c-ink)">
                        {u}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Domains">
                <ul className="divide-y divide-(--c-line)">
                  {net.domains.map((d) => (
                    <li key={d.domain} className="flex items-center justify-between px-4 py-2 text-[13px]">
                      <span className="capitalize text-(--c-ink)">{d.domain}</span>
                      {domainBadge(d.status)}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>

            <Card title={`Callbacks from seller apps, last ${ops.windowDays} days`}>
              {ops.callbacks.byAction.length === 0 ? (
                <Empty>No live callbacks yet.</Empty>
              ) : (
                <Table head={["Action", "ACK", "NACK", "Error"]}>
                  {ops.callbacks.byAction.map((a) => (
                    <tr key={a.action}>
                      <td className="px-4 py-2 font-mono">{a.action}</td>
                      <td className="px-4 py-2">{a.ack}</td>
                      <td className="px-4 py-2">{a.nack > 0 ? <Badge tone="amber">{a.nack}</Badge> : 0}</td>
                      <td className="px-4 py-2">{a.error > 0 ? <Badge tone="red">{a.error}</Badge> : 0}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card title="Observability log queue">
              {ops.observability.lastFailure ? (
                <div className="px-4 py-3 text-[12px] text-(--c-ink)">
                  <p className="mb-1 font-semibold">Most recent failure</p>
                  <p className="font-mono">
                    {ops.observability.lastFailure.domain} {ops.observability.lastFailure.type}, {ops.observability.lastFailure.attempts}{" "}
                    attempts
                  </p>
                  <p className="mt-1 break-words font-mono text-(--c-muted)">{ops.observability.lastFailure.lastError}</p>
                </div>
              ) : (
                <Empty>No failures waiting.</Empty>
              )}
            </Card>

            <Card title="ONDC food orders">
              <CountList rows={ops.orders} empty="No ONDC orders yet." />
            </Card>
            <Card title={`Waiting on a seller (${ops.waiting.length})`}>
              {ops.waiting.length === 0 ? (
                <Empty>No order is waiting on a seller past its limit.</Empty>
              ) : (
                <Table head={["Order", "Waiting for", "For", "Paid"]}>
                  {ops.waiting.map((w) => (
                    <tr key={w.id}>
                      <td className="px-4 py-2">
                        <p className="font-medium text-(--c-ink)">{w.store}</p>
                        <p className="font-mono text-[11px] text-(--c-muted)">{w.bppId}</p>
                        <p className="font-mono text-[11px] text-(--c-muted)">{w.id}</p>
                      </td>
                      <td className="px-4 py-2">{WAITING_FOR[w.status] ?? w.status}</td>
                      <td className="px-4 py-2">{`${w.waitingMinutes} min`}</td>
                      <td className="px-4 py-2">
                        {w.paidPaise != null ? <Badge tone="red">{`Rs ${(w.paidPaise / 100).toFixed(2)} held`}</Badge> : <Badge tone="slate">Not paid</Badge>}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="ONDC rides">
              <CountList rows={ops.rides} empty="No ONDC rides yet." />
            </Card>
            <Card title="Settlements">
              <CountList rows={ops.settlements} empty="No settlement rows yet." />
            </Card>
          </div>
        </>
      )}
    </ConsolePage>
  );
}
