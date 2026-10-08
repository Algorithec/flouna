"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Mail, Phone, Lock, Eye, EyeOff } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { Select } from "@/components/ui/Select";
import { useAuth, type User } from "@/components/auth/AuthContext";
import { FlounaLogo } from "@/components/brand/FlounaLogo";
import {
  AuthField,
  AuthButton,
  AuthAltButton,
  AuthOr,
} from "@/components/auth/AuthField";

// Figma "Log in or sign up" (2177:7108 email / 2177:7168 phone). One screen in
// two modes, each offering to continue with the other.
//
// The password step is the one thing the frames don't draw: they stop at
// "Continue". Accounts here are password-backed, so the field is revealed in
// place after Continue rather than on a screen of its own — same surface, same
// treatment, no invented navigation.
const COUNTRIES = [
  { label: "India (+91)", dial: "+91" },
  { label: "United States (+1)", dial: "+1" },
  { label: "United Kingdom (+44)", dial: "+44" },
  { label: "United Arab Emirates (+971)", dial: "+971" },
];

export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { setUser } = useAuth();
  const [mode, setMode] = useState<"email" | "phone">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState(false);
  // Set when the account has two-factor on: the password was accepted but no
  // session exists yet, so the form asks for the emailed code before going on.
  const [askCode, setAskCode] = useState(false);
  const [code, setCode] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [dial, setDial] = useState(COUNTRIES[0].dial);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneValid = phone.replace(/\D/g, "").length >= 7;

  async function onEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!askPassword) {
      setAskPassword(true);
      return;
    }
    setBusy(true);
    try {
      // Two-factor accounts answer the code step instead of the password step.
      if (askCode) {
        const verified = await api<{ user: User }>("/api/auth/login/verify", {
          method: "POST",
          json: { email: email.trim(), code },
        });
        setUser(verified.user);
        router.replace("/home");
        return;
      }

      const d = await api<{ user?: User; next?: string }>("/api/auth/login", {
        method: "POST",
        json: { email: email.trim(), password },
      });
      // Password was right, but this account needs the emailed code as well.
      if (d.next === "two-factor" || !d.user) {
        setAskCode(true);
        setCode("");
        setInfo("We emailed you a 6-digit code.");
        return;
      }
      setUser(d.user);
      router.replace("/home");
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        // Account exists but email unverified — backend has re-sent a code.
        sessionStorage.setItem("pendingEmail", email.trim());
        router.replace("/verify");
        return;
      }
      setError(err instanceof Error ? err.message : t("au.signInFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onPhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      await api("/api/auth/phone/send-otp", {
        method: "POST",
        json: { phone: `${dial}${phone.replace(/\D/g, "")}` },
      });
      sessionStorage.setItem("pendingPhone", `${dial}${phone.replace(/\D/g, "")}`);
      router.replace("/verify");
    } catch (err) {
      // The backend returns 501 until an SMS provider is contracted. Say so
      // plainly and point at the path that does work, rather than failing mute.
      setError(
        err instanceof ApiClientError && err.status === 501
          ? t("au.phoneUnavailable")
          : err instanceof Error
            ? err.message
            : t("pp.priv.codeSendFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-auth-bg px-5 py-4 [@media(max-width:480px)]:py-2">
      <div className="mx-auto w-full max-w-[420px]">
        <Link
          href="/"
          aria-label={t("au.back")}
          className="flex size-10 items-center justify-center rounded-full bg-auth-well text-auth-ink transition-colors hover:bg-auth-well/80"
        >
          <ArrowLeft size={20} />
        </Link>

        <div className="mt-4 flex flex-col items-center text-center [@media(max-width:480px)]:mt-1">
          {/* Shrinks on short phones so the whole screen fits without scrolling —
              the mark is the most compressible thing here. */}
          <FlounaLogo
            size={92}
            className="size-[92px] text-auth-ink/80 [@media(max-width:480px)]:size-[56px]"
          />
          <h1 className="mt-5 text-[26px] font-bold text-auth-ink [@media(max-width:480px)]:mt-3 [@media(max-width:480px)]:text-[22px]">
            {t("au.loginOrSignup")}
          </h1>
          <p className="mt-2 max-w-[330px] text-[15px] leading-[1.45] text-auth-muted [@media(max-width:480px)]:text-[13px]">
            {t("au.smarter")}
          </p>
        </div>

        {mode === "email" ? (
          <form onSubmit={onEmailSubmit} className="mt-6 flex flex-col gap-3 [@media(max-width:480px)]:mt-4 [@media(max-width:480px)]:gap-2">
            <AuthField
              label={t("au.email")}
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setAskPassword(false);
                setAskCode(false);
              }}
              required
            />
            {askPassword && !askCode && (
              <AuthField
                label={t("au.password")}
                type={showPw ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                icon={<Lock size={18} />}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? t("au.hidePw") : t("au.showPw")}
                    className="rounded-full p-1 text-auth-muted transition-colors hover:text-auth-ink"
                  >
                    {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            )}
            {askCode && (
              <AuthField
                label={t("au.code")}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                icon={<Lock size={18} />}
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                required
              />
            )}
            {error && (
              <p role="alert" className="text-[14px] text-danger">
                {error}
              </p>
            )}
            <AuthButton
              type="submit"
              disabled={
                busy ||
                !emailValid ||
                (askCode ? code.length !== 6 : askPassword && !password)
              }
            >
              {busy
                ? t("au.signingIn")
                : askCode
                  ? t("au.verify")
                  : askPassword
                    ? t("au.logIn")
                    : t("au.continue")}
            </AuthButton>
            {askPassword && !askCode && (
              <Link
                href="/forgot"
                className="-mt-1 self-center text-[15px] font-semibold text-auth-ink hover:underline"
              >
                {t("au.forgot")}
              </Link>
            )}
          </form>
        ) : (
          <form onSubmit={onPhoneSubmit} className="mt-6 flex flex-col gap-3 [@media(max-width:480px)]:mt-4 [@media(max-width:480px)]:gap-2">
            <div className="flex flex-col gap-2">
              {/* The chevron and the wrapper that positioned it are gone: the
                  themed Select draws its own, and rotates it when open. */}
              <span className="text-[13px] font-medium text-auth-ink">
                {t("au.country")}
              </span>
              <Select
                variant="auth"
                value={dial}
                label={t("au.country")}
                options={COUNTRIES.map((c) => ({ value: c.dial, label: c.label }))}
                onChange={setDial}
              />
            </div>
            <AuthField
              label={t("au.phone")}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t("au.phone")}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            {error && (
              <p role="alert" className="text-[14px] text-danger">
                {error}
              </p>
            )}
            <AuthButton type="submit" disabled={busy || !phoneValid}>
              {busy ? t("au.sending") : t("au.sendVerification")}
            </AuthButton>
          </form>
        )}

        {info && <p className="mt-3 text-center text-[14px] text-auth-muted">{info}</p>}

        <div className="mt-5 [@media(max-width:480px)]:mt-3">
          <AuthOr />
        </div>

        <div className="mt-5 flex flex-col gap-3 [@media(max-width:480px)]:mt-3 [@media(max-width:480px)]:gap-2">
          <GoogleButton onError={setError} label={t("au.google")} />
          <AuthAltButton
            type="button"
            onClick={() => {
              setMode(mode === "email" ? "phone" : "email");
              setError("");
              setAskPassword(false);
            }}
          >
            {mode === "email" ? (
              <>
                <Phone size={20} /> {t("au.withPhone")}
              </>
            ) : (
              <>
                <Mail size={20} /> {t("au.withEmail")}
              </>
            )}
          </AuthAltButton>
        </div>

        <p className="mt-5 text-center text-[14px] text-auth-muted [@media(max-width:480px)]:mt-3">
          {t("au.newHere")}{" "}
          <Link href="/signup" className="font-bold text-auth-ink hover:underline">
            {t("au.create")}
          </Link>
        </p>

        <p className="mt-3 pb-4 text-center text-[14px] [@media(max-width:480px)]:mt-2 [@media(max-width:480px)]:pb-2">
          <Link href="/legal/terms" className="font-medium text-auth-ink hover:underline">
            {t("au.termsOfUse")}
          </Link>
          <span className="px-2 text-auth-muted">·</span>
          <Link href="/legal/privacy" className="font-medium text-auth-ink hover:underline">
            {t("au.privacy")}
          </Link>
        </p>
      </div>
    </div>
  );
}
