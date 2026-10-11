"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { StatCard } from "@/components/console/ConsoleShell";
import { ConsolePage, Card, Table, Badge, Empty } from "@/components/console/ui";

type Key = {
  id: string;
  name: string;
  client: string;
  prefix: string;
  scope: string;
  lastUsedAt: string | null;
  callCount: number;
  expiresAt: string | null;
  revoked: boolean;
  expired: boolean;
};

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: "", client: "", scope: "read" });
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape closed the new-key form only while focus was already inside it, and
  // nothing focused it on open, so in practice it closed neither dialog. Every
  // other sheet in the product answers Escape.
  useEscapeToClose(showNew && !busy, () => setShowNew(false));

  function load() {
    api<{ keys: Key[] }>("/api/console/super/api-keys")
      .then((d) => setKeys(d.keys))
      .catch(() => setKeys([]));
  }
  useEffect(load, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ key: string }>("/api/console/super/api-keys", {
        method: "POST",
        json: form,
      });
      setCopied(false);
      setCreated(res.key); // show ONCE
      setShowNew(false);
      setForm({ name: "", client: "", scope: "read" });
      load();
    } catch (err) {
      // There was no catch, so a refused create became an unhandled rejection:
      // the dialog sat there with the form filled in, no key, and no reason.
      setError(err instanceof Error ? err.message : "Could not generate that key.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api(`/api/console/super/api-keys/${id}`, { method: "DELETE" });
    } catch (err) {
      // The failure was swallowed and the list reloaded, so a key that is
      // still live came back reading "Active" and the operator had no way to
      // tell that from a revoke that worked. This is the screen somebody uses
      // when a partner's key has leaked.
      setError(err instanceof Error ? err.message : "Could not revoke that key.");
    }
    load();
  }

  const active = keys.filter((k) => !k.revoked && !k.expired).length;

  return (
    <ConsolePage accept={["super_admin"]}>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-(--c-ink)">API keys</h1>
          <p className="mt-1 text-[13px] text-(--c-muted)">
            For MSME / partner integrations. The secret is shown once at creation.
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 rounded-lg bg-(--c-maroon) px-3 py-2 text-[13px] font-semibold text-white hover:bg-[#690a17]"
        >
          <Plus size={15} /> Generate key
        </button>
      </div>

      {error && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-(--c-red)/10 px-3 py-2 text-[13px] text-(--c-red)">
          <AlertTriangle size={15} /> {error}
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Active keys" value={active} tone="good" />
        <StatCard label="Total keys" value={keys.length} />
        <StatCard label="Revoked" value={keys.filter((k) => k.revoked).length} />
      </div>

      <Card title="Key management">
        {keys.length === 0 ? (
          <Empty>No API keys yet.</Empty>
        ) : (
          <Table head={["Name", "Key", "Client", "Calls", "Scope", "Status", ""]}>
            {keys.map((k) => (
              <tr key={k.id} className="hover:bg-[#f7f1e6]">
                <td className="px-4 py-2.5 font-medium text-(--c-ink)">{k.name}</td>
                <td className="px-4 py-2.5 font-mono text-(--c-muted)">{k.prefix}_••••</td>
                <td className="px-4 py-2.5 text-(--c-muted)">{k.client}</td>
                <td className="px-4 py-2.5 text-(--c-ink)">{k.callCount}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={k.scope === "read_write" ? "purple" : "slate"}>{k.scope}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  {k.revoked ? (
                    <Badge tone="red">Revoked</Badge>
                  ) : k.expired ? (
                    <Badge tone="amber">Expired</Badge>
                  ) : (
                    <Badge tone="green">Active</Badge>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {!k.revoked && (
                    <button
                      onClick={() => revoke(k.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-(--c-border) px-2 py-1 text-[11px] text-(--c-red) hover:bg-[#f0e8da]"
                    >
                      <Trash2 size={12} /> Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* New-key modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={create}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-key-title"
            onKeyDown={(e) => e.key === "Escape" && setShowNew(false)}
            className="w-full max-w-sm rounded-xl border border-(--c-border) bg-white p-5"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 id="new-key-title" className="text-[15px] font-semibold text-(--c-ink)">
                Generate API key
              </h3>
              <button
                type="button"
                onClick={() => setShowNew(false)}
                aria-label="Close"
                className="text-(--c-muted)"
              >
                <X size={18} />
              </button>
            </div>
            <label className="mb-3 block">
              <span className="text-[12px] text-(--c-muted)">Name</span>
              <input
                required
                autoFocus
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="mt-1 w-full rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[14px] text-(--c-ink) outline-none focus:border-(--c-maroon)"
              />
            </label>
            <label className="mb-3 block">
              <span className="text-[12px] text-(--c-muted)">Client</span>
              <input
                required
                value={form.client}
                onChange={(e) => setForm({ ...form, client: e.target.value })}
                className="mt-1 w-full rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[14px] text-(--c-ink) outline-none focus:border-(--c-maroon)"
              />
            </label>
            <label className="mb-4 block">
              <span className="text-[12px] text-(--c-muted)">Scope</span>
              <select
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value })}
                className="mt-1 w-full rounded-lg border border-(--c-border) bg-white px-3 py-2 text-[14px] text-(--c-ink)"
              >
                <option value="read">Read only</option>
                <option value="read_write">Read &amp; write</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-(--c-maroon) py-2 text-[14px] font-semibold text-white hover:bg-[#690a17] disabled:opacity-50"
            >
              Generate
            </button>
          </form>
        </div>
      )}

      {/* Show-once secret */}
      {created && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="key-created-title"
            className="w-full max-w-md rounded-xl border border-[#9fd8bc] bg-white p-5"
          >
            <h3 id="key-created-title" className="text-[15px] font-semibold text-(--c-ink)">
              Copy your API key now
            </h3>
            <p className="mt-1 text-[12px] text-(--c-gold)">
              This is the only time the secret is shown. Store it securely.
            </p>
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-(--c-border) bg-white px-3 py-2.5">
              <code className="flex-1 break-all font-mono text-[12px] text-[#1a7a4a]">{created}</code>
              {/* Copy said nothing either way. On the one secret the system
                  will never show again, a clipboard write that was refused —
                  no permission, or a non-secure origin, where the API is not
                  even defined — looked exactly like one that worked. */}
              <button
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(created)
                    .then(() => setCopied(true))
                    .catch(() =>
                      setError("Could not copy. Select the key above and copy it by hand."),
                    );
                }}
                aria-label="Copy key"
                className="shrink-0 text-(--c-muted) hover:text-(--c-ink)"
              >
                {copied ? <Check size={15} className="text-[#1a7a4a]" /> : <Copy size={15} />}
              </button>
            </div>
            {copied && (
              <p className="mt-2 text-[12px] font-semibold text-[#1a7a4a]">
                Copied to the clipboard.
              </p>
            )}
            {/* Deliberately not closed by Escape: the secret is shown once, so
                a stray key press must not be able to throw it away. */}
            <button
              onClick={() => setCreated(null)}
              className="mt-4 w-full rounded-lg border border-(--c-border) py-2 text-[13px] text-(--c-ink) hover:bg-[#f0e8da]"
            >
              I&apos;ve saved it
            </button>
          </div>
        </div>
      )}
    </ConsolePage>
  );
}
