"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useBackTo } from "@/lib/navHistory";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { api } from "@/lib/api";
import { FlounaLogo } from "@/components/brand/FlounaLogo";
import { AuthField, AuthButton } from "@/components/auth/AuthField";

type Step = "email" | "reset";

// Password reset, on the auth flow's own palette and field treatment.
//
// The Figma set doesn't draw this screen, so it is composed from that flow's
// existing parts rather than invented: the same back button, lotus, navy
// headline and orange-labelled white pill inputs as "Log in or sign up", and
// the six-box code entry from OTP Verify. Nothing here is a new visual idea —
// it just stops /forgot being the one screen still wearing the brand palette.
export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const router = useRouter();
  const leaveAuth = useBackTo("/login");
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const code = digits.join("");
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const mismatch = confirm.length > 0 && password !== confirm;
  const canReset = code.length === 6 && password.length >= 8 && password === confirm;

  function setDigit(i: number, value: string) {
    const v = value.replace(/\D/g, "").slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[i] = v;
      return next;
    });
    if (v && i < 5) inputs.current[i + 1]?.focus();
  }

  function onKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[i] && i > 0) inputs.current[i - 1]?.focus();
  }

  function onPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (text.length === 6) {
      e.preventDefault();
      setDigits(text.split(""));
      inputs.current[5]?.focus();
    }
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/auth/forgot", { method: "POST", json: { email: email.trim() } });
      setStep("reset");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pp.priv.codeSendFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError(t("au.pwMismatch"));
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/reset", {
        method: "POST",
        json: { email: email.trim(), code, password },
      });
      // The reset is done; going back into the form would be meaningless.
      router.replace("/login?reset=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("au.resetFailed"));
      setBusy(false);
    }
  }

  const eye = (
    <button
      type="button"
      onClick={() => setShowPw((v) => !v)}
      aria-label={showPw ? t("au.hidePw") : t("au.showPw")}
      className="rounded-full p-1 text-auth-muted transition-colors hover:text-auth-ink"
    >
      {showPw ? <EyeOff size={20} /> : <Eye size={20} />}
    </button>
  );

  return (
    <div className="min-h-dvh bg-auth-bg px-5 py-5 [@media(max-width:480px)]:py-2">
      <div className="mx-auto w-full max-w-[420px]">
        <button
          type="button"
          onClick={() => (step === "reset" ? setStep("email") : leaveAuth())}
          aria-label={t("au.back")}
          className="flex size-10 items-center justify-center rounded-full bg-auth-well text-auth-ink transition-colors hover:bg-auth-well/80"
        >
          <ArrowLeft size={20} />
        </button>

        <div className="mt-6 flex flex-col items-center text-center [@media(max-width:480px)]:mt-1">
          {/* The reset step stacks a code plus two password fields — shrink the
              header more aggressively than the other auth screens so that step
              still fits a short phone without scrolling. */}
          <FlounaLogo
            size={92}
            className="size-[92px] text-auth-ink/80 [@media(max-width:480px)]:size-[44px]"
          />
          <h1 className="mt-7 text-[26px] font-bold text-auth-ink [@media(max-width:480px)]:mt-2 [@media(max-width:480px)]:text-[19px]">
            {step === "email" ? t("au.resetTitle") : t("au.newPwTitle")}
          </h1>
          <p className="mt-3 max-w-[330px] text-[16px] leading-[1.5] text-auth-muted [@media(max-width:480px)]:mt-1 [@media(max-width:480px)]:text-[12px] [@media(max-width:480px)]:leading-[1.3]">
            {step === "email" ? (
              t("au.enterEmail")
            ) : (
              <>
                {t("au.sentTo").split("{email}")[0]}
                <span className="font-semibold text-auth-ink">{email}</span>
                {t("au.sentTo").split("{email}")[1]}
              </>
            )}
          </p>
        </div>

        {step === "email" ? (
          <form onSubmit={sendCode} className="mt-9 flex flex-col gap-4 [@media(max-width:480px)]:mt-4 [@media(max-width:480px)]:gap-2">
            <AuthField
              label={t("au.email")}
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {error && (
              <p role="alert" className="text-[14px] text-danger">
                {error}
              </p>
            )}
            <AuthButton type="submit" disabled={busy || !emailValid}>
              {busy ? t("au.sending") : t("au.sendCode")}
            </AuthButton>
          </form>
        ) : (
          <form onSubmit={resetPassword} className="mt-9 flex flex-col gap-5 [@media(max-width:480px)]:mt-2 [@media(max-width:480px)]:gap-1">
            <div
              className="flex justify-center gap-2.5"
              onPaste={onPaste}
              role="group"
              aria-label={t("au.resetCode")}
            >
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    inputs.current[i] = el;
                  }}
                  inputMode="numeric"
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  // Was an English literal. The six boxes are the only thing on this
                  // screen a screen reader has to be told about, and they were the
                  // one part not translated.
                  aria-label={t("au.digit").replace("{n}", String(i + 1))}
                  value={d}
                  autoFocus={i === 0}
                  onChange={(e) => setDigit(i, e.target.value)}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  className="size-[58px] rounded-[16px] bg-auth-well text-center text-[24px] font-bold text-auth-ink outline-none transition-colors focus:ring-2 focus:ring-white/25 [@media(max-width:480px)]:size-[44px] [@media(max-width:480px)]:text-[18px]"
                />
              ))}
            </div>

            <AuthField
              label={t("au.newPw")}
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              trailing={eye}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
            <AuthField
              label={t("au.reenterPw")}
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              error={mismatch ? t("au.pwMismatch") : undefined}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              required
            />

            {error && (
              <p role="alert" className="text-[14px] text-danger">
                {error}
              </p>
            )}

            <AuthButton type="submit" disabled={busy || !canReset}>
              {busy ? t("au.resetting") : t("au.resetBtn")}
            </AuthButton>

            <button
              type="button"
              onClick={() => {
                setStep("email");
                setDigits(Array(6).fill(""));
              }}
              className="text-[15px] font-bold text-auth-ink hover:underline"
            >
              {t("au.sendAgain")}
            </button>
          </form>
        )}

        <p className="mt-7 pb-8 text-center text-[15px] text-auth-muted [@media(max-width:480px)]:mt-3 [@media(max-width:480px)]:pb-2">
          {t("au.remembered")}{" "}
          <Link href="/login" className="font-bold text-auth-ink hover:underline">
            {t("au.logIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
