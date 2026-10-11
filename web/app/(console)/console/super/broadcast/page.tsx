"use client";

import { useState } from "react";
import { Megaphone, Send, CheckCircle2, AlertTriangle } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { PageTitle } from "@/components/console/ConsoleShell";
import { ConsolePage, Card } from "@/components/console/ui";

type Result = { configured: boolean; sent: number; failed: number; devices: number };

export default function BroadcastPage() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One tap used to push a notification to every subscribed device on the
  // platform, with nothing in the way and nothing to undo it afterwards. The
  // page's own subtitle says "use sparingly", which is not a guard. The button
  // now asks once.
  const [confirming, setConfirming] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<Result>("/api/console/super/broadcast", {
        method: "POST",
        json: { title, body, ...(url.trim() ? { url: url.trim() } : {}) },
      });
      setResult(res);
      if (res.configured) {
        setTitle("");
        setBody("");
        setUrl("");
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Broadcast failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConsolePage accept={["super_admin"]}>
      <PageTitle
        title="Broadcast"
        subtitle="Send a push notification to every subscribed device. Use sparingly, every send is audited."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Compose announcement">
          <form onSubmit={send} className="space-y-4 p-5">
            <label className="block">
              <span className="c-label text-[10.5px]" style={{ color: "var(--c-muted)" }}>
                Title
              </span>
              <input
                required
                minLength={3}
                maxLength={80}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setConfirming(false);
                }}
                placeholder="e.g. New: live order tracking"
                className="c-input mt-1.5 w-full rounded-lg px-3 py-2.5 text-[14px] outline-none"
              />
            </label>
            <label className="block">
              <span className="c-label text-[10.5px]" style={{ color: "var(--c-muted)" }}>
                Message
              </span>
              <textarea
                required
                minLength={3}
                maxLength={300}
                rows={4}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setConfirming(false);
                }}
                placeholder="Short, useful, worth interrupting someone for."
                className="c-input mt-1.5 w-full resize-none rounded-lg px-3 py-2.5 text-[14px] outline-none"
              />
            </label>
            <label className="block">
              <span className="c-label text-[10.5px]" style={{ color: "var(--c-muted)" }}>
                Open on tap (optional path)
              </span>
              <input
                maxLength={200}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setConfirming(false);
                }}
                placeholder="/home"
                className="c-input c-mono mt-1.5 w-full rounded-lg px-3 py-2.5 text-[13px] outline-none"
              />
            </label>

            {error && (
              <p
                className="rounded-lg px-3 py-2 text-[13px]"
                style={{ background: "#f6e7e5", color: "var(--c-red)" }}
              >
                {error}
              </p>
            )}

            {confirming && (
              <p
                className="flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]"
                style={{ background: "#fef3dc", color: "#b8690a" }}
              >
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                This goes to every subscribed device and cannot be recalled.
                Press again to send.
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={busy || title.trim().length < 3 || body.trim().length < 3}
                className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: confirming ? "var(--c-red)" : "var(--c-maroon)" }}
              >
                <Send size={15} />
                {confirming ? "Confirm send" : "Send to all devices"}
              </button>
              {confirming && (
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="text-[13px] font-medium"
                  style={{ color: "var(--c-muted)" }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </Card>

        <div className="space-y-4">
          {/* Live preview of what users will see */}
          <Card title="Preview">
            <div className="p-5">
              <div
                className="flex items-start gap-3 rounded-xl bg-white p-4"
                style={{ border: "1px solid var(--c-border)", boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg text-white"
                  style={{ background: "var(--c-crimson)" }}
                >
                  <Megaphone size={16} style={{ color: "var(--c-amber)" }} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-bold" style={{ color: "var(--c-ink)" }}>
                    {title.trim() || "Notification title"}
                  </p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: "var(--c-muted)" }}>
                    {body.trim() || "Your message appears here exactly as users will read it."}
                  </p>
                </div>
              </div>
            </div>
          </Card>

          {result && (
            <Card>
              <div className="flex items-start gap-3 p-5">
                {result.configured ? (
                  <>
                    <CheckCircle2 size={18} className="mt-0.5 shrink-0" style={{ color: "#1a7a4a" }} />
                    <div>
                      {/* "Delivered" was an overclaim: `sent` counts the
                          pushes the push service accepted, not the ones a
                          phone showed. An accepted push on a device that is
                          off, or has notifications muted, is counted here and
                          never seen. */}
                      <p className="text-[14px] font-semibold" style={{ color: "var(--c-ink)" }}>
                        Accepted for {result.sent} of {result.devices} device
                        {result.devices === 1 ? "" : "s"}
                      </p>
                      <p className="mt-0.5 text-[12px]" style={{ color: "var(--c-muted)" }}>
                        Accepted by the push service, which is not the same as
                        shown on a phone.
                      </p>
                      {result.failed > 0 && (
                        <p className="mt-0.5 text-[12px]" style={{ color: "var(--c-muted)" }}>
                          {result.failed} failed (expired subscriptions are pruned automatically).
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={18} className="mt-0.5 shrink-0" style={{ color: "var(--c-gold)" }} />
                    <div>
                      <p className="text-[14px] font-semibold" style={{ color: "var(--c-ink)" }}>
                        Push isn&apos;t configured yet
                      </p>
                      <p className="mt-0.5 text-[12px] leading-relaxed" style={{ color: "var(--c-muted)" }}>
                        Nothing was sent. Set VAPID keys in the server env (npx web-push
                        generate-vapid-keys) and users must enable notifications in Settings.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </ConsolePage>
  );
}
