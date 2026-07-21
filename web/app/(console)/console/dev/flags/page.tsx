"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useOperator } from "@/components/console/useOperator";
import { ConsoleShell, PageTitle } from "@/components/console/ConsoleShell";

type Flag = {
  key: string;
  enabled: boolean;
  description: string;
  updatedAt: string | null;
};

export default function DevFlagsPage() {
  const state = useOperator(["developer", "super_admin"]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  function load() {
    api<{ flags: Flag[] }>("/api/console/dev/flags")
      .then((d) => setFlags(d.flags))
      .catch(() => setFlags([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (state.status === "ok") load();
  }, [state.status]);

  async function toggle(flag: Flag) {
    setSaving(flag.key);
    // Optimistic flip, reverted on failure.
    setFlags((fs) =>
      fs.map((f) => (f.key === flag.key ? { ...f, enabled: !f.enabled } : f)),
    );
    try {
      await api(`/api/console/dev/flags/${flag.key}`, {
        method: "PATCH",
        json: { enabled: !flag.enabled },
      });
    } catch {
      setFlags((fs) =>
        fs.map((f) => (f.key === flag.key ? { ...f, enabled: flag.enabled } : f)),
      );
    } finally {
      setSaving(null);
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
      <PageTitle
        title="Feature flags"
        subtitle="Gate risky behaviour without a redeploy. Every change is audited."
      />

      {loading ? (
        <div className="flex justify-center py-16 text-(--c-muted)">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="space-y-2">
          {flags.map((flag) => (
            <div
              key={flag.key}
              className="flex items-center gap-4 rounded-xl border border-(--c-border) bg-white p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[13px] text-(--c-ink)">{flag.key}</p>
                <p className="mt-0.5 text-[12px] text-(--c-muted)">{flag.description}</p>
              </div>
              <button
                onClick={() => toggle(flag)}
                disabled={saving === flag.key}
                aria-pressed={flag.enabled}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  flag.enabled ? "bg-(--c-maroon)" : "bg-[#d9cdba]"
                } disabled:opacity-60`}
              >
                <span
                  className={`absolute top-0.5 size-5 rounded-full bg-white transition-transform ${
                    flag.enabled ? "translate-x-[22px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </ConsoleShell>
  );
}
