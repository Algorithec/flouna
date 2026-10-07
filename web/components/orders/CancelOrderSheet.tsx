"use client";

import { useEffect, useState } from "react";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { Check, IndianRupee, Clock, XCircle } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";

// Cancellation (Figma "Cancel Ride?" — the fee/ETA warning and the reason
// live on one screen, not staged behind a separate "why" step: reading the
// warning and picking a reason both take a few seconds either way, and a
// second screen just adds a tap. Reason stays optional — skipping it and
// hitting "Yes, Cancel" is a valid answer.
//
// The single entry point for cancelling anywhere in the app — the order page
// owns this dialog, and RideTracker's cancel buttons ask for it via a prop
// rather than running their own second dialog.
const RIDE_REASONS = ["Wrong pickup", "Changed plans", "Wait too long", "Other reason"];
const FOOD_REASONS = ["Changed my plans", "Ordered by mistake", "Taking too long", "Other reason"];

type Step = "confirm" | "done";

// What the refund policy says about this specific order, right now.
type Terms = {
  freeWindow: boolean;
  windowRemainingMs: number;
  unpaid: boolean;
  summary: string;
  refundDays: { min: number; max: number };
};

export function CancelOrderSheet({
  orderId,
  domain,
  driverName,
  etaMinutes,
  onClose,
  onCancelled,
}: {
  orderId: string;
  domain: string;
  /** Ride only — who the driver row in the warning box refers to. */
  driverName?: string | null;
  /** Ride only — feeds "Driver is only N min away from you". */
  etaMinutes?: number | null;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [step, setStep] = useState<Step>("confirm");
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState(false);
  useEscapeToClose(!busy, onClose);
  const [error, setError] = useState("");
  const [terms, setTerms] = useState<Terms | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // The terms come from the server, which is also what enforces them. Working
  // the window out here from the phone's clock would show a countdown that
  // disagrees with the rule being applied, for anyone whose clock is off.
  useEffect(() => {
    let alive = true;
    api<Terms>(`/api/orders/${orderId}/cancellation`)
      .then((t) => {
        if (!alive) return;
        setTerms(t);
        if (t.freeWindow && !t.unpaid) {
          setSecondsLeft(Math.ceil(t.windowRemainingMs / 1000));
        }
      })
      // A failure here must not block cancelling. The sheet falls back to
      // saying nothing about fees, which is better than guessing wrong in
      // either direction.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [orderId]);

  // Counts the free window down while the sheet is open, so somebody sitting
  // on this screen can see it running out rather than discovering afterwards
  // that it had.
  useEffect(() => {
    if (secondsLeft === null || secondsLeft <= 0) return;
    const id = setInterval(() => {
      setSecondsLeft((n) => (n === null ? null : Math.max(0, n - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  const isRide = domain === "ride";
  const noun = isRide ? "booking" : "order";
  const reasons = isRide ? RIDE_REASONS : FOOD_REASONS;

  async function cancel(withReason?: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/orders/${orderId}/cancel`, {
        method: "POST",
        json: withReason ? { reason: withReason } : {},
      });
      onCancelled();
      setStep("done");
    } catch (err) {
      // The server enforces the real rules — food already out for delivery,
      // a completed trip, an already-cancelled order. Surfaced as-is rather
      // than guessed at in the client, which would drift from the policy.
      setError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : `Could not cancel this ${noun}`,
      );
      setStep("confirm");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Cancel ${noun}`}
      onClick={(e) => {
        // Only a click on the backdrop itself dismisses.
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-t-[32px] bg-auth-bg p-6 shadow-lift sm:rounded-[32px]">
        {step === "confirm" && (
          <>
            <p className="text-center text-[24px] font-bold text-ink">
              {isRide ? "Cancel Ride?" : "Cancel Order?"}
            </p>
            <p className="mx-auto mt-2 max-w-[280px] text-center text-[14px] text-cocoa">
              Are you sure you want to cancel{" "}
              {isRide && driverName ? `your ride with ${driverName}` : `this ${noun}`}?
            </p>

            {/* What the refund policy actually promises for this order.
                This used to read "Cancellation fee of ₹50 may apply", shown to
                everybody, including inside the five minute window where the
                policy promises a full refund with no deductions. The app was
                warning people off a right they had. */}
            <div className="mt-4 flex flex-col gap-3 rounded-[20px] border border-accent/60 px-4 py-3.5">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                  <IndianRupee size={14} className="text-ink" />
                </span>
                <span className="text-[14px] leading-snug text-ink">
                  {terms ? terms.summary : "Checking your refund terms\u2026"}
                </span>
              </div>
              {secondsLeft !== null && secondsLeft > 0 && (
                <div className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                    <Clock size={14} className="text-ink" />
                  </span>
                  <span className="text-[14px] text-ink">
                    Free cancellation for another{" "}
                    <b>
                      {Math.floor(secondsLeft / 60)}:
                      {String(secondsLeft % 60).padStart(2, "0")}
                    </b>
                  </span>
                </div>
              )}
              {isRide && etaMinutes != null && (
                <div className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                    <Clock size={14} className="text-ink" />
                  </span>
                  <span className="text-[14px] text-ink">
                    Driver is only {etaMinutes} min away from you
                  </span>
                </div>
              )}
            </div>

            <p className="mt-4 text-[14px] font-bold text-ink">Reason for cancellation</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {reasons.map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  onClick={() => setReason(r)}
                  className={
                    reason === r
                      ? "rounded-pill border border-accent px-4 py-2 text-[13px] font-semibold text-accent"
                      : "rounded-pill border border-line bg-card px-4 py-2 text-[13px] font-medium text-ink"
                  }
                >
                  {r}
                </button>
              ))}
            </div>

            {error && (
              <p role="alert" className="mt-3 text-[14px] text-danger">
                {error}
              </p>
            )}

            <div className="mt-5 flex gap-3">
              <button
                disabled={busy}
                onClick={onClose}
                className="flex-1 rounded-pill border border-line py-3 text-[14px] font-bold text-ink disabled:opacity-60"
              >
                {isRide ? "Keep Ride" : `Keep ${noun}`}
              </button>
              <button
                disabled={busy}
                onClick={() => cancel(reason || undefined)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-accent text-[14px] font-bold text-accent disabled:opacity-60"
              >
                <XCircle size={16} />
                {busy ? "Cancelling…" : "Yes, Cancel"}
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <div className="flex flex-col items-center py-4 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-success/10">
              <Check size={32} className="text-success" strokeWidth={3} />
            </span>
            <h2 className="mt-5 text-[20px] font-bold text-ink">
              {isRide ? "Booking cancelled" : "Order cancelled"}
            </h2>
            <p className="mt-2 max-w-[300px] text-[14px] leading-relaxed text-cocoa">
              {/* Deliberately not claiming the money is back. The server flags a
                  paid order for refund; when it actually lands is not something
                  this screen knows. */}
              If you paid for this {noun}, your refund has been started and will
              show in your original payment method.
            </p>
            <button
              onClick={onClose}
              className="mt-6 h-[52px] w-full rounded-pill bg-ink text-[16px] font-bold text-white transition-opacity hover:opacity-90"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
