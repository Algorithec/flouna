"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useBackTo } from "@/lib/navHistory";
import {
  ArrowLeft,
  ChevronRight,
  MapPin,
  Eye,
  Activity,
  UserX,
  Lock,
  Fingerprint,
  ShieldCheck,
  Monitor,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth/AuthContext";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/components/i18n/I18nContext";
import { cn } from "@/lib/cn";
import {
  isDeviceLockSupported,
  registerDeviceLock,
  forgetDeviceLock,
} from "@/lib/deviceLock";

// Figma "Privacy & Security" (2195:852). Eight controls across two sections,
// all of them real:
//
// Share My Location gates the rides screen auto-reading the rider's position.
// Profile Visibility and Activity Status change what other members of a shared
// cart are shown — the one place the product puts two accounts together.
// Blocked Users stops someone joining a cart you host, and vice versa.
// Change Password runs the existing email-code reset. Biometric Lock registers
// this device's fingerprint/face through WebAuthn; AppLock then holds the whole
// signed-in shell behind that check on this device until it is passed.
// Two-Factor emails a code on every password login. Login Activity lists the
// real sessions and can end any of them.

type Prefs = {
  shareLocation: boolean;
  profileVisibility: "everyone" | "contacts" | "nobody";
  activityStatus: boolean;
  twoFactorEnabled: boolean;
  biometricLock: boolean;
};

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "tap-target h-[30px] w-[52px] shrink-0 rounded-full transition-colors",
        checked ? "bg-acct-accent" : "bg-switch-off",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-6 rounded-full bg-white shadow transition-[left]",
          checked ? "left-[25px]" : "left-[3px]",
        )}
      />
    </button>
  );
}

function Row({
  icon: Icon,
  title,
  subtitle,
  value,
  children,
  href,
  onClick,
}: {
  icon: typeof MapPin;
  title: string;
  subtitle: string;
  value?: string;
  children?: React.ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-acct-tint">
        <Icon size={16} className="text-acct-accent" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-acct-ink">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-acct-muted">
          {subtitle}
        </span>
      </span>
      {value && (
        <span className="shrink-0 text-[13px] font-medium text-acct-muted">{value}</span>
      )}
      {children ?? <ChevronRight size={17} className="shrink-0 text-acct-muted" />}
    </>
  );

  const cls =
    "flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-left last:border-b-0";

  if (href) {
    return (
      <Link href={href} className={cn(cls, "transition-colors hover:bg-acct-bg")}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button onClick={onClick} className={cn(cls, "transition-colors hover:bg-acct-bg")}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** Bottom sheet used by the visibility picker and the two-factor steps. */
function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 lg:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-3xl bg-card p-5 lg:rounded-3xl"
      >
        <div className="flex items-center justify-between">
          <p className="text-[16px] font-bold text-acct-ink">{title}</p>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-full p-1.5 text-acct-muted hover:bg-acct-bg"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function PrivacySecurityPage() {
  const goBack = useBackTo("/profile");
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useI18n();

  // Built here rather than at module scope so the labels follow the language.
  const VISIBILITY_LABEL: Record<Prefs["profileVisibility"], string> = {
    everyone: t("pp.priv.visEveryone"),
    contacts: t("pp.priv.visContacts"),
    nobody: t("pp.priv.visNobody"),
  };
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [sessions, setSessions] = useState<number | null>(null);
  const [blockedCount, setBlockedCount] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [twoFactorStep, setTwoFactorStep] = useState<null | "code" | "password">(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<Prefs>("/api/users/preferences")
      .then(setPrefs)
      .catch(() => setPrefs(null));
    api<{ count: number }>("/api/users/sessions")
      .then((d) => setSessions(d.count))
      .catch(() => setSessions(null));
    api<{ blocked: unknown[] }>("/api/users/blocked")
      .then((d) => setBlockedCount(d.blocked.length))
      .catch(() => setBlockedCount(null));
  }, []);
  useEffect(load, [load]);

  /** Optimistic write with a rollback, so a switch never claims an unsaved state. */
  async function savePref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    const previous = prefs?.[key];
    setPrefs((p) => (p ? { ...p, [key]: value } : p));
    try {
      await api("/api/users/preferences", { method: "PUT", json: { [key]: value } });
    } catch {
      setPrefs((p) => (p && previous !== undefined ? { ...p, [key]: previous } : p));
      toast(t("pp.priv.saveFailed"));
    }
  }

  async function toggleBiometric(on: boolean) {
    if (!on) {
      setBusy(true);
      try {
        await api("/api/users/device-locks", { method: "DELETE" });
        forgetDeviceLock();
        setPrefs((p) => (p ? { ...p, biometricLock: false } : p));
        toast(t("pp.priv.bioOff"));
      } catch {
        toast(t("pp.priv.bioFailed"));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!isDeviceLockSupported()) {
      toast(t("pp.priv.bioUnsupported"));
      return;
    }
    setBusy(true);
    try {
      const credentialId = await registerDeviceLock(
        user?.email ?? "account",
        user?.name ?? "Flouna",
      );
      await api("/api/users/device-locks", {
        method: "POST",
        json: { credentialId },
      });
      setPrefs((p) => (p ? { ...p, biometricLock: true } : p));
      toast(t("pp.priv.bioOn"));
    } catch (err) {
      toast(
        err instanceof Error && err.name === "NotAllowedError"
          ? t("pp.priv.cancelled")
          : t("pp.priv.bioFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function startTwoFactor() {
    setBusy(true);
    setError("");
    try {
      await api("/api/users/two-factor/start", { method: "POST" });
      setCode("");
      setTwoFactorStep("code");
    } catch (err) {
      toast(err instanceof Error ? err.message : t("pp.priv.codeSendFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function confirmTwoFactor() {
    setBusy(true);
    setError("");
    try {
      await api("/api/users/two-factor/confirm", { method: "POST", json: { code } });
      setPrefs((p) => (p ? { ...p, twoFactorEnabled: true } : p));
      setTwoFactorStep(null);
      toast(t("pp.priv.twoFactorOn"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pp.priv.codeFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function disableTwoFactor() {
    setBusy(true);
    setError("");
    try {
      await api("/api/users/two-factor/disable", { method: "POST", json: { password } });
      setPrefs((p) => (p ? { ...p, twoFactorEnabled: false } : p));
      setTwoFactorStep(null);
      setPassword("");
      toast(t("pp.priv.twoFactorOff"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pp.priv.offFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center py-4">
          <button
            onClick={goBack}
            aria-label={t("common.back")}
            className="tap-target flex size-9 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg"
          >
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <h1 className="flex-1 pr-9 text-center text-[17px] font-extrabold text-acct-ink">
            {t("pp.profile.privacy")}
          </h1>
        </div>

        <p className="mb-2 px-1 text-[13px] font-semibold text-acct-muted">
          {t("pp.priv.privacy")}
        </p>
        <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
          <Row
            icon={MapPin}
            title={t("pp.priv.shareLoc")}
            subtitle={t("pp.priv.shareLocSub")}
          >
            <Toggle
              label={t("pp.priv.shareLoc")}
              checked={prefs?.shareLocation ?? true}
              onChange={(v) => savePref("shareLocation", v)}
              disabled={!prefs}
            />
          </Row>
          <Row
            icon={Eye}
            title={t("pp.priv.visibility")}
            subtitle={t("pp.priv.visibilitySub")}
            value={prefs ? VISIBILITY_LABEL[prefs.profileVisibility] : undefined}
            onClick={prefs ? () => setPicking(true) : undefined}
          />
          <Row
            icon={Activity}
            title={t("pp.priv.activity")}
            subtitle={t("pp.priv.activitySub")}
          >
            <Toggle
              label={t("pp.priv.activity")}
              checked={prefs?.activityStatus ?? true}
              onChange={(v) => savePref("activityStatus", v)}
              disabled={!prefs}
            />
          </Row>
          <Row
            icon={UserX}
            title={t("pp.priv.blocked")}
            subtitle={t("pp.priv.blockedSub")}
            value={blockedCount ? String(blockedCount) : undefined}
            href="/profile/blocked"
          />
        </div>

        <p className="mb-2 mt-7 px-1 text-[13px] font-semibold text-acct-muted">
          {t("pp.priv.security")}
        </p>
        <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
          <Row
            icon={Lock}
            title={t("pp.priv.changePw")}
            subtitle={t("pp.priv.changePwSub")}
            href="/forgot"
          />
          <Row
            icon={Fingerprint}
            title={t("pp.priv.biometric")}
            subtitle={t("pp.priv.biometricSub")}
          >
            <Toggle
              label={t("pp.priv.biometric")}
              checked={prefs?.biometricLock ?? false}
              onChange={toggleBiometric}
              disabled={!prefs || busy}
            />
          </Row>
          <Row
            icon={ShieldCheck}
            title={t("pp.priv.twoFactor")}
            subtitle={t("pp.priv.twoFactorSub")}
            value={
              prefs ? (prefs.twoFactorEnabled ? t("pp.priv.on") : t("pp.priv.off")) : undefined
            }
            onClick={
              !prefs || busy
                ? undefined
                : prefs.twoFactorEnabled
                  ? () => {
                      setPassword("");
                      setError("");
                      setTwoFactorStep("password");
                    }
                  : startTwoFactor
            }
          />
          <Row
            icon={Monitor}
            title={t("pp.priv.loginActivity")}
            subtitle={t("pp.priv.loginActivitySub")}
            value={sessions === null ? undefined : String(sessions)}
            href="/profile/sessions"
          />
        </div>
      </div>

      {picking && prefs && (
        <Sheet title={t("pp.priv.visibility")} onClose={() => setPicking(false)}>
          <p className="mt-1 text-[13px] text-acct-muted">{t("pp.priv.visHint")}</p>
          <div className="mt-4 flex flex-col gap-2">
            {(["everyone", "contacts", "nobody"] as const).map((v) => (
              <button
                key={v}
                onClick={() => {
                  void savePref("profileVisibility", v);
                  setPicking(false);
                }}
                className={cn(
                  "flex items-center gap-3 rounded-[14px] border px-4 py-3 text-left transition-colors",
                  prefs.profileVisibility === v
                    ? "border-acct-accent bg-acct-tint"
                    : "border-line hover:bg-acct-bg",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border-2",
                    prefs.profileVisibility === v
                      ? "border-acct-accent"
                      : "border-line",
                  )}
                >
                  {prefs.profileVisibility === v && (
                    <span className="size-2.5 rounded-full bg-acct-accent" />
                  )}
                </span>
                <span className="text-[15px] font-semibold text-acct-ink">
                  {VISIBILITY_LABEL[v]}
                </span>
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {twoFactorStep === "code" && (
        <Sheet title={t("pp.priv.twoFactor")} onClose={() => setTwoFactorStep(null)}>
          <p className="mt-1 text-[13px] text-acct-muted">
            {t("pp.priv.codeSentTo").replace("{email}", user?.email ?? "")}
          </p>
          <input
            autoFocus
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            className="mt-4 h-14 w-full rounded-[12px] border border-line bg-acct-bg text-center text-[22px] font-bold tracking-[0.4em] text-acct-ink outline-none focus:border-acct-accent"
          />
          {error && (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              {error}
            </p>
          )}
          <button
            disabled={busy || code.length !== 6}
            onClick={confirmTwoFactor}
            className="mt-4 h-[52px] w-full rounded-pill bg-acct-accent text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t("pp.priv.checking") : t("pp.priv.turnOn")}
          </button>
        </Sheet>
      )}

      {twoFactorStep === "password" && (
        <Sheet title={t("pp.priv.turnOff2fa")} onClose={() => setTwoFactorStep(null)}>
          <p className="mt-1 text-[13px] text-acct-muted">
            {t("pp.priv.passwordToRemove")}
          </p>
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("pp.priv.yourPassword")}
            className="mt-4 h-12 w-full rounded-[12px] border border-line bg-acct-bg px-3.5 text-[15px] text-acct-ink outline-none focus:border-acct-accent"
          />
          {error && (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              {error}
            </p>
          )}
          <button
            disabled={busy || !password}
            onClick={disableTwoFactor}
            className="mt-4 h-[52px] w-full rounded-pill bg-danger text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t("pp.priv.turningOff") : t("pp.priv.turnOff")}
          </button>
        </Sheet>
      )}
    </div>
  );
}
