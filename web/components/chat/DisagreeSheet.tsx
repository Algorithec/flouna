"use client";

import { useState } from "react";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

// Disagreeing with what the engine chose.
//
// AI policy 2.5 gives a route to say the ranking was wrong and have it looked
// at within five business days. 2.6 is the stronger one: a person may require
// that a human reviews a decision an automated system made about them, and may
// not be forced to accept the machine's answer. The reasons offered here are
// the examples the policy itself lists.
//
// The human-review box is unticked by default. Ticking it for everybody would
// make the request meaningless, and the right is about being able to insist,
// not about insisting on everyone's behalf.

const WANTED = [
  { value: "cheaper", label: "I wanted it cheaper" },
  { value: "faster", label: "I wanted it faster" },
  { value: "better_rated", label: "Better rated seller" },
  { value: "different_seller", label: "A different seller" },
  { value: "wrong_price", label: "The price looks wrong" },
  { value: "unavailable", label: "This is not available" },
  { value: "other", label: "Something else" },
] as const;

export function DisagreeSheet({
  orderId,
  onClose,
}: {
  orderId?: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [wanted, setWanted] = useState<string>("");
  const [reason, setReason] = useState("");
  const [human, setHuman] = useState(false);
  const [busy, setBusy] = useState(false);
  useEscapeToClose(!busy, onClose);
  const [done, setDone] = useState<{ dueBy: string } | null>(null);

  async function submit() {
    setBusy(true);
    try {
      const res = await api<{ dueBy: string }>("/api/privacy/appeals", {
        method: "POST",
        json: {
          reason: reason.trim() || WANTED.find((w) => w.value === wanted)?.label || "Disagreed",
          ...(wanted ? { wanted } : {}),
          ...(orderId ? { orderId } : {}),
          humanReview: human,
        },
      });
      setDone(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send that");
    } finally {
      setBusy(false);
    }
  }

  const by = done
    ? new Date(done.dueBy).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
      })
    : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Disagree with this recommendation"
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-t-[28px] bg-card p-5 shadow-lift sm:rounded-[28px]">
        {done ? (
          <>
            <p className="text-[18px] font-bold text-ink">Thanks, that is logged</p>
            <p className="mt-2 text-[14px] leading-relaxed text-cocoa">
              {human
                ? `A person will look at this and reply by ${by}.`
                : `We review this and reply by ${by}.`}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="tap-target mt-4 w-full rounded-pill bg-accent px-4 py-3 text-[14px] font-bold text-white"
            >
              Done
            </button>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <p className="text-[18px] font-bold text-ink">
                What should it have picked?
              </p>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="tap-target -mr-1 -mt-1 rounded-full p-1 text-muted hover:bg-beige"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {WANTED.map((w) => (
                <button
                  key={w.value}
                  type="button"
                  onClick={() => setWanted(wanted === w.value ? "" : w.value)}
                  className={cn(
                    "tap-target rounded-pill border px-3 py-2 text-[13px] transition-colors",
                    wanted === w.value
                      ? "border-accent bg-accent text-white"
                      : "border-line text-cocoa hover:bg-beige/50",
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>

            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Tell us more, if you want to"
              className="mt-3 w-full resize-none rounded-2xl border border-line bg-cream px-3.5 py-3 text-[16px] text-ink outline-none focus:border-accent"
            />

            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug text-cocoa">
              <input
                type="checkbox"
                checked={human}
                onChange={(e) => setHuman(e.target.checked)}
                className="mt-0.5 size-[17px] shrink-0 accent-accent"
              />
              <span>
                I want a person to review this, not the system that made the
                decision.
              </span>
            </label>

            <button
              type="button"
              onClick={submit}
              disabled={busy || (!wanted && reason.trim().length < 3)}
              className="tap-target mt-4 w-full rounded-pill bg-accent px-4 py-3 text-[14px] font-bold text-white disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
