"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth, type User } from "@/components/auth/AuthContext";
import { AccountSetup } from "@/components/auth/AccountSetup";
import { FlounaLogo } from "@/components/brand/FlounaLogo";

const RESEND_SECONDS = 45;

// Figma "OTP Verify" (2177:7484): back button, lotus, the same headline the
// entry screen carries, six boxes, and a resend countdown. No submit button is
// drawn, so the code submits itself once the sixth digit lands — guarded so a
// rejected code can't resubmit in a loop while the boxes are still full.
export default function VerifyEmailPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { setUser } = useAuth();
  const [email, setEmail] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const attempted = useRef<string>("");

  useEffect(() => {
    // Deferred a tick: sessionStorage is an external store, and the state
    // update must happen in a callback rather than the effect body.
    const t = setTimeout(() => {
      const pending = sessionStorage.getItem("pendingEmail");
      if (!pending) router.replace("/signup");
      else setEmail(pending);
    }, 0);
    return () => clearTimeout(t);
  }, [router]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  const verify = useCallback(async () => {
    const code = digits.join("");
    if (code.length !== 6 || !email || busy) return;
    attempted.current = code;
    setError("");
    setBusy(true);
    try {
      const d = await api<{ user: User }>("/api/auth/verify-email", {
        method: "POST",
        json: { email, code },
      });
      sessionStorage.removeItem("pendingEmail");
      setUser(d.user);
      setSettingUp(true); // themed transition handles the redirect
    } catch (err) {
      setError(err instanceof Error ? err.message : t("au.verifyFailed"));
      setBusy(false);
      // Clear so the next attempt is a fresh six digits, and put the caret back
      // at the start — otherwise the boxes stay full with a code already known
      // to be wrong.
      setDigits(Array(6).fill(""));
      inputs.current[0]?.focus();
    }
  }, [digits, email, busy, setUser, t]);

  useEffect(() => {
    const code = digits.join("");
    if (code.length === 6 && code !== attempted.current && email && !busy) {
      void verify();
    }
  }, [digits, email, busy, verify]);

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
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      inputs.current[i - 1]?.focus();
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (text.length === 6) {
      e.preventDefault();
      setDigits(text.split(""));
      inputs.current[5]?.focus();
    }
  }

  async function resend() {
    if (secondsLeft > 0 || !email) return;
    setError("");
    try {
      await api("/api/auth/resend-otp", { method: "POST", json: { email } });
      setSecondsLeft(RESEND_SECONDS);
      // A fresh code invalidates the old one — clear the boxes so stale digits
      // can't auto-submit against it.
      setDigits(Array(6).fill(""));
      attempted.current = "";
      inputs.current[0]?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("au.resendFailed"));
    }
  }

  if (settingUp) {
    return <AccountSetup onDone={() => router.replace("/home")} />;
  }

  return (
    <div className="min-h-dvh bg-auth-bg px-5 py-5 [@media(max-width:480px)]:py-2">
      <div className="mx-auto w-full max-w-[420px]">
        <Link
          href="/signup"
          aria-label={t("au.back")}
          className="flex size-10 items-center justify-center rounded-full bg-auth-well text-auth-ink transition-colors hover:bg-auth-well/80"
        >
          <ArrowLeft size={20} />
        </Link>

        <div className="mt-6 flex flex-col items-center text-center [@media(max-width:480px)]:mt-1">
          <FlounaLogo
            size={92}
            className="size-[92px] text-auth-ink/80 [@media(max-width:480px)]:size-[56px]"
          />
          <h1 className="mt-7 text-[26px] font-bold text-auth-ink [@media(max-width:480px)]:mt-2 [@media(max-width:480px)]:text-[20px]">
            {t("au.loginOrSignup")}
          </h1>
          <p className="mt-3 max-w-[330px] text-[16px] leading-[1.5] text-auth-muted [@media(max-width:480px)]:mt-1 [@media(max-width:480px)]:text-[12px] [@media(max-width:480px)]:leading-[1.3]">
            {t("au.smarter")}
          </p>
        </div>

        <div
          className="mt-10 flex justify-center gap-2.5 [@media(max-width:480px)]:mt-3"
          onPaste={onPaste}
          aria-label={t("au.code")}
          role="group"
        >
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                inputs.current[i] = el;
              }}
              inputMode="numeric"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              aria-label={`Digit ${i + 1}`}
              value={d}
              disabled={busy}
              autoFocus={i === 0}
              onChange={(e) => setDigit(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              className="size-[58px] rounded-[16px] bg-auth-well text-center text-[24px] font-bold text-auth-ink outline-none transition-colors focus:ring-2 focus:ring-white/25 disabled:opacity-60 [@media(max-width:480px)]:size-[46px] [@media(max-width:480px)]:text-[20px]"
            />
          ))}
        </div>

        <p className="mt-7 text-center text-[16px] text-auth-muted [@media(max-width:480px)]:mt-3 [@media(max-width:480px)]:text-[14px]">
          {t("au.noCode")}{" "}
          {secondsLeft > 0 ? (
            <span className="font-bold text-auth-accent">
              {t("au.resendIn").replace("{s}", String(secondsLeft).padStart(2, "0"))}
            </span>
          ) : (
            <button
              onClick={resend}
              className="font-bold text-auth-ink hover:underline"
            >
              {t("au.resendNow")}
            </button>
          )}
        </p>

        {busy && (
          <p className="mt-4 text-center text-[15px] text-auth-muted">
            {t("au.verifying")}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-center text-[15px] text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
