"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, MinusCircle, AlertCircle } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { ConsolePage, Card } from "@/components/console/ui";

type Settings = {
  ondcMinMarginBps: number;
  ondcMaxMarginBps: number;
  partnerAffiliateMinBps: number;
  cashbackUserSharePct: number;
  apiFailureRatePct: number;
  decisionLatencyAlertSec: number;
  ondcPingAlertMs: number;
};

type ConfigStatus = {
  runtime: { nodeEnv: string; providerMode: string; llmProvider: string };
  secrets: Record<string, boolean>;
};

// Field definitions: label, key, unit, and whether the raw value is bps (shown
// as %) or a plain number.
const FIELDS: { key: keyof Settings; label: string; unit: string; bps?: boolean }[] = [
  { key: "ondcMinMarginBps", label: "ONDC min margin", unit: "%", bps: true },
  { key: "ondcMaxMarginBps", label: "ONDC max margin", unit: "%", bps: true },
  { key: "partnerAffiliateMinBps", label: "Partner affiliate min", unit: "%", bps: true },
  { key: "cashbackUserSharePct", label: "Cashback share to user", unit: "%" },
  { key: "apiFailureRatePct", label: "API failure-rate alert", unit: "%" },
  { key: "decisionLatencyAlertSec", label: "Decision latency alert", unit: "s" },
  { key: "ondcPingAlertMs", label: "ONDC ping alert", unit: "ms" },
];

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [cfg, setCfg] = useState<ConfigStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // What is in each box while it is being typed, which is not the same as the
  // number behind it. The percentage boxes are stored as basis points, so the
  // value was round-tripped through Number on every keystroke: typing "4."
  // became 4, React wrote "4" back into the box, the dot vanished, and the
  // next keystroke made "45". An operator setting a 4.5% margin set 45%. The
  // ONDC fields are clamped on the server; cashback share is not.
  const [draft, setDraft] = useState<Partial<Record<keyof Settings, string>>>({});

  useEffect(() => {
    api<Settings>("/api/console/super/settings").then(setS).catch(() => {});
    api<ConfigStatus>("/api/console/super/config").then(setCfg).catch(() => {});
  }, []);

  function setField(key: keyof Settings, text: string, bps?: boolean) {
    if (!s) return;
    setDraft((d) => ({ ...d, [key]: text }));
    const n = Number(text);
    // An empty or half-typed box leaves the stored number alone rather than
    // writing a zero that was never meant.
    if (text.trim() === "" || !Number.isFinite(n)) return;
    // % fields stored as basis points: 4% → 400 bps.
    setS({ ...s, [key]: bps ? Math.round(n * 100) : Math.round(n) });
  }

  async function save() {
    if (!s) return;
    setSaving(true);
    setMsg(null);
    try {
      const updated = await api<Settings>("/api/console/super/settings", {
        method: "PATCH",
        json: s,
      });
      setS(updated); // reflect any server-side clamping
      setDraft({}); // so clamped values are shown, not what was typed
      setMsg("Saved. ONDC margins are clamped to DPIIT norms (3 to 6%).");
    } catch (err) {
      setMsg(err instanceof ApiClientError ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConsolePage accept={["super_admin"]}>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-(--c-ink)">Settings</h1>
          <p className="mt-1 text-[13px] text-(--c-muted)">
            Commission and alert thresholds. ONDC margins are bounded by government norms.
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving || !s}
          className="rounded-lg bg-(--c-maroon) px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#690a17] disabled:opacity-50"
        >
          Save changes
        </button>
      </div>

      {msg && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[13px] text-(--c-ink)">
          <AlertCircle size={15} className="text-(--c-gold)" /> {msg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Thresholds">
          <div className="divide-y divide-(--c-line)">
            {s &&
              FIELDS.map((f) => {
                const display = f.bps ? s[f.key] / 100 : s[f.key];
                return (
                  <div key={f.key} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                    <span className="text-(--c-ink)">{f.label}</span>
                    <span className="flex items-center gap-2">
                      <input
                        type="number"
                        step={f.bps ? "0.1" : "1"}
                        value={draft[f.key] ?? String(display)}
                        onChange={(e) => setField(f.key, e.target.value, f.bps)}
                        className="w-20 rounded-md border border-(--c-border) bg-white px-2 py-1 text-right text-[13px] text-(--c-ink)"
                      />
                      <span className="w-6 text-(--c-muted)">{f.unit}</span>
                    </span>
                  </div>
                );
              })}
          </div>
        </Card>

        <Card title="Configuration status">
          {cfg && (
            <>
              <div className="flex flex-wrap gap-2 border-b border-(--c-border) px-4 py-3">
                {Object.entries(cfg.runtime).map(([k, v]) => (
                  <span key={k} className="rounded bg-(--c-ivory) px-2 py-1 text-[11px]">
                    <span className="text-(--c-muted)">{k.replace(/([A-Z])/g, " $1")}</span>{" "}
                    <span className="font-mono text-[#1a7a4a]">{v}</span>
                  </span>
                ))}
              </div>
              <ul className="divide-y divide-(--c-line)">
                {Object.entries(cfg.secrets).map(([key, on]) => (
                  <li key={key} className="flex items-center justify-between px-4 py-2 text-[12px]">
                    <span className="capitalize text-(--c-ink)">{key.replace(/([A-Z])/g, " $1")}</span>
                    {on ? (
                      <span className="flex items-center gap-1 text-[#1a7a4a]">
                        <CheckCircle2 size={13} /> set
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-(--c-muted)">
                        <MinusCircle size={13} /> not set
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
    </ConsolePage>
  );
}
