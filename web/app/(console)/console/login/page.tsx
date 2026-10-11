"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Loader2, KeyRound, ArrowLeft } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import type { Operator, Role } from "@/components/console/useOperator";

// Where each operator role lands after sign-in.
function homeFor(role: Role): string {
  if (role === "developer") return "/console/dev";
  if (role === "super_admin") return "/console/super";
  if (role === "admin") return "/console/admin";
  return "/console/login";
}

// The consumer OTP screen gates its resend behind the same countdown. Only the
// server limits how many codes an address may have in flight, and it answers
// the overrun with a 429 — which also happens to be the limit the verify call
// shares, so an operator who taps a silent button a few times locks themselves
// out of the console for the rate-limit window.
const RESEND_SECONDS = 45;

export default function ConsoleLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "otp">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendLeft, setResendLeft] = useState(RESEND_SECONDS);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (step !== "otp" || resendLeft <= 0) return;
    const t = setTimeout(() => setResendLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [step, resendLeft]);

  // Step 1: password → triggers the emailed second factor for operators.
  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/console/login", { method: "POST", json: { email, password } });
      setResendLeft(RESEND_SECONDS);
      setResent(false);
      setStep("otp");
    } catch (err) {
      // 404 (not an operator) is shown the same as bad credentials — no leak.
      const msg =
        err instanceof ApiClientError && err.status === 404
          ? "This account doesn't have console access."
          : err instanceof ApiClientError
            ? err.message
            : "Sign in failed, try again.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  // Step 2: the 6-digit code → starts the verified operator session.
  async function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api<{ user: Operator }>("/api/auth/console/verify", {
        method: "POST",
        json: { email, code },
      });
      router.replace(homeFor(user.role));
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Verification failed, try again.",
      );
      setBusy(false);
    }
  }

  async function resend() {
    if (resendLeft > 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/console/login", { method: "POST", json: { email, password } });
      setResendLeft(RESEND_SECONDS);
      setResent(true);
    } catch (err) {
      // Said out loud rather than swallowed. A refusal here is normally the
      // code allowance, and an operator who is told nothing reads the silence
      // as a broken button and keeps pressing.
      setError(
        err instanceof ApiClientError ? err.message : "Could not send another code.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span
            className="flex size-12 items-center justify-center rounded-xl text-white"
            style={{ background: "var(--c-crimson)" }}
          >
            <ShieldCheck size={24} style={{ color: "var(--c-amber)" }} />
          </span>
          <h1
            className="c-serif mt-4 text-xl font-extrabold"
            style={{ color: "var(--c-maroon)" }}
          >
            Flouna Console
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--c-muted)" }}>
            Operator access only. Two-factor required. All actions are audited.
          </p>
        </div>

        {step === "password" ? (
          <form
            onSubmit={submitPassword}
            className="space-y-3 rounded-2xl bg-white p-6"
            style={{ border: "1px solid var(--c-border)" }}
          >
            <label className="block">
              <span className="text-[12px] font-medium" style={{ color: "var(--c-muted)" }}>Email</span>
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="c-input mt-1 w-full rounded-lg px-3 py-2.5 text-[14px] outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[12px] font-medium" style={{ color: "var(--c-muted)" }}>Password</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="c-input mt-1 w-full rounded-lg px-3 py-2.5 text-[14px] outline-none"
              />
            </label>

            {error && (
              <p
                className="rounded-lg px-3 py-2 text-[13px]"
                style={{ background: "#F6E7E5", color: "var(--c-red)" }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: "var(--c-maroon)" }}
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              Continue
            </button>
          </form>
        ) : (
          <form
            onSubmit={submitOtp}
            className="space-y-3 rounded-2xl bg-white p-6"
            style={{ border: "1px solid var(--c-border)" }}
          >
            <div className="mb-2 flex items-start gap-2 text-[13px]" style={{ color: "var(--c-ink)" }}>
              <KeyRound size={15} className="mt-0.5 shrink-0" style={{ color: "var(--c-amber)" }} />
              <p className="leading-relaxed">
                We emailed a 6-digit code to{" "}
                <span className="font-semibold break-all">{email}</span>.
              </p>
            </div>
            <input
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="······"
              className="c-input c-mono w-full rounded-lg px-3 py-3 text-center text-[20px] tracking-[0.4em] outline-none"
            />

            {error && (
              <p
                className="rounded-lg px-3 py-2 text-[13px]"
                style={{ background: "#F6E7E5", color: "var(--c-red)" }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: "var(--c-maroon)" }}
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              Verify &amp; sign in
            </button>

            <div className="flex items-center justify-between pt-1 text-[12px]">
              <button
                type="button"
                onClick={() => {
                  setStep("password");
                  setCode("");
                  setError(null);
                }}
                className="flex items-center gap-1 hover:opacity-80"
                style={{ color: "var(--c-muted)" }}
              >
                <ArrowLeft size={13} /> Back
              </button>
              {resendLeft > 0 ? (
                <span style={{ color: "var(--c-muted)" }}>
                  {resent ? "New code sent · " : ""}Resend in{" "}
                  {String(resendLeft).padStart(2, "0")}s
                </span>
              ) : (
                <button
                  type="button"
                  onClick={resend}
                  disabled={busy}
                  className="font-semibold hover:opacity-80 disabled:opacity-50"
                  style={{ color: "var(--c-red)" }}
                >
                  Resend code
                </button>
              )}
            </div>
          </form>
        )}

        <p className="mt-6 text-center text-[12px]" style={{ color: "var(--c-muted)" }}>
          Unauthorized access is prohibited and logged.
        </p>
      </div>
    </div>
  );
}
