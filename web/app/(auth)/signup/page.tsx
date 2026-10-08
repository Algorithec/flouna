"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { api } from "@/lib/api";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { FlounaLogo } from "@/components/brand/FlounaLogo";
import {
  AuthField,
  AuthButton,
  AuthOr,
} from "@/components/auth/AuthField";

// Figma "Create Account Light" (2177:7394): the identifier carried from the
// entry screen shown read-only with an Edit link, then Create Password,
// Re-Enter the Password, Continue, an OR rule and Continue with Google.
export default function SignupPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [dob, setDob] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Shown on the field itself, beside the box that has to change, rather than
  // only in the summary line at the foot of the form.
  const mismatch = confirm.length > 0 && password !== confirm;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  // Flouna is 18+ (Terms 3.1). Checked here so the person is told before they
  // finish the form, and checked again on the server, which is the one that
  // decides — this control never sees a request sent by hand.
  const adult = (() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
    const [y, m, d] = dob.split("-").map(Number);
    const born = new Date(Date.UTC(y, m - 1, d));
    if (born.getUTCFullYear() !== y || born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d) {
      return false;
    }
    const now = new Date();
    let age = now.getUTCFullYear() - y;
    if (now.getUTCMonth() < m - 1 || (now.getUTCMonth() === m - 1 && now.getUTCDate() < d)) {
      age -= 1;
    }
    return age >= 18;
  })();
  // Only complain once they have typed a whole date, so the message does not
  // appear while they are still on the first digit of the year.
  const tooYoung = dob.length === 10 && !adult;

  const ready =
    name.trim().length >= 2 &&
    emailValid &&
    password.length >= 8 &&
    password === confirm &&
    adult &&
    accepted;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError(t("au.pwMismatch"));
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/signup", {
        method: "POST",
        json: {
          name: name.trim(),
          email: email.trim(),
          password,
          dateOfBirth: dob,
          acceptTerms: true,
        },
      });
      sessionStorage.setItem("pendingEmail", email.trim());
      // The account exists now; back into the signup form would only fail.
      router.replace("/verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("au.signupFailed"));
    } finally {
      setBusy(false);
    }
  }

  const eye = (shown: boolean, toggle: () => void) => (
    <button
      type="button"
      onClick={toggle}
      aria-label={shown ? t("au.hidePw") : t("au.showPw")}
      className="rounded-full p-1 text-auth-muted transition-colors hover:text-auth-ink"
    >
      {shown ? <EyeOff size={20} /> : <Eye size={20} />}
    </button>
  );

  return (
    <div className="min-h-dvh bg-auth-bg px-5 py-5 [@media(max-width:480px)]:py-2">
      <div className="mx-auto w-full max-w-[420px]">
        <Link
          href="/login"
          aria-label={t("au.back")}
          className="flex size-10 items-center justify-center rounded-full bg-auth-well text-auth-ink transition-colors hover:bg-auth-well/80"
        >
          <ArrowLeft size={20} />
        </Link>

        <div className="mt-6 flex flex-col items-center text-center [@media(max-width:480px)]:mt-1">
          {/* Shrinks on short phones so a four-field form still fits without
              scrolling — the mark is the most compressible thing here. */}
          <FlounaLogo
            size={92}
            className="size-[92px] text-auth-ink/80 [@media(max-width:480px)]:size-[48px]"
          />
          <h1 className="mt-7 text-[26px] font-bold text-auth-ink [@media(max-width:480px)]:mt-2 [@media(max-width:480px)]:text-[20px]">
            {t("au.loginOrSignup")}
          </h1>
          <p className="mt-3 max-w-[330px] text-[16px] leading-[1.5] text-auth-muted [@media(max-width:480px)]:mt-1 [@media(max-width:480px)]:text-[12px] [@media(max-width:480px)]:leading-[1.3]">
            {t("au.smarter")}
          </p>
        </div>

        <form onSubmit={onSubmit} className="mt-9 flex flex-col gap-5 [@media(max-width:480px)]:mt-2 [@media(max-width:480px)]:gap-1">
          <AuthField
            label={t("au.fullName")}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            required
          />
          <AuthField
            label={t("au.email")}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <AuthField
            label={t("au.createPw")}
            type={showPw ? "text" : "password"}
            autoComplete="new-password"
            trailing={eye(showPw, () => setShowPw((v) => !v))}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          <AuthField
            label={t("au.reenterPw")}
            type={showConfirm ? "text" : "password"}
            autoComplete="new-password"
            trailing={eye(showConfirm, () => setShowConfirm((v) => !v))}
            error={mismatch ? t("au.pwMismatch") : undefined}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={8}
            required
          />

          <AuthField
            label={t("au.dob")}
            type="date"
            autoComplete="bday"
            error={tooYoung ? t("au.must18") : undefined}
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            required
          />

          {/* Unticked by default and not submittable until ticked. A box that
              starts ticked records an agreement nobody actually made, which is
              the thing a consent record is supposed to be able to prove. */}
          <label className="flex cursor-pointer items-start gap-3 text-[14px] leading-[1.45] text-auth-muted">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5 size-[18px] shrink-0 accent-accent"
              required
            />
            <span>
              {t("au.agreePrefix")}{" "}
              <Link href="/legal/terms" className="font-medium text-auth-ink underline">
                {t("au.termsOfService")}
              </Link>
              ,{" "}
              <Link href="/legal/privacy" className="font-medium text-auth-ink underline">
                {t("au.privacy")}
              </Link>{" "}
              {t("au.and")}{" "}
              <Link href="/legal/acceptable-use" className="font-medium text-auth-ink underline">
                {t("au.aup")}
              </Link>
              .
            </span>
          </label>

          {error && (
            <p role="alert" className="text-[14px] text-danger">
              {error}
            </p>
          )}

          <AuthButton type="submit" disabled={busy || !ready}>
            {busy ? t("au.creating") : t("au.continue")}
          </AuthButton>
        </form>

        <div className="mt-7 [@media(max-width:480px)]:mt-3">
          <AuthOr />
        </div>

        <div className="mt-7 [@media(max-width:480px)]:mt-3">
          <GoogleButton onError={setError} label={t("au.google")} />
        </div>

        <p className="mt-7 text-center text-[15px] text-auth-muted [@media(max-width:480px)]:mt-3">
          {t("au.haveAccount")}{" "}
          <Link href="/login" className="font-bold text-auth-ink hover:underline">
            {t("au.logIn")}
          </Link>
        </p>

        <p className="mt-4 pb-8 text-center text-[15px] [@media(max-width:480px)]:mt-2 [@media(max-width:480px)]:pb-2">
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
