"use client";

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, LogOut } from "lucide-react";
import { useAuth } from "@/components/auth/AuthContext";
import { useI18n } from "@/components/i18n/I18nContext";
import {
  hasDeviceLock,
  isUnlocked,
  verifyDeviceLock,
  lockNow,
  forgetDeviceLock,
} from "@/lib/deviceLock";

// Biometric Lock, the part the user actually meets.
//
// Gates every signed-in screen on THIS device when a platform credential has
// been registered here and the last unlock has expired. Deliberately a local
// gate, not authentication: the session cookie is untouched, so this hides the
// app from someone holding an unlocked phone rather than pretending to be a
// second login factor (two-factor is a separate control for that).
//
// Whether this device is locked is read from local storage, not the account:
// the server flag only says "some device has this on", and applying that to a
// device with no credential registered would lock a user out of a phone that
// cannot possibly satisfy the prompt.
export function AppLock({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  // null = still deciding, so nothing flashes before the check runs.
  const [locked, setLocked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const unlock = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      const ok = await verifyDeviceLock();
      if (ok) setLocked(false);
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  // Decide on mount, and prompt straight away rather than making the user tap
  // an extra button to reach the system sheet they are expecting. The decision
  // runs inside an async task rather than in the effect body: local storage and
  // the authenticator are external systems, and setting state synchronously
  // here would cascade a second render before the first has painted.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user || !hasDeviceLock() || isUnlocked()) {
        if (!cancelled) setLocked(false);
        return;
      }
      if (!cancelled) setLocked(true);
      const ok = await verifyDeviceLock();
      if (cancelled) return;
      if (ok) setLocked(false);
      else setFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Re-lock when the app goes to the background, which is the moment the phone
  // usually changes hands.
  useEffect(() => {
    if (!user || !hasDeviceLock()) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") lockNow();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [user]);

  if (locked === null) {
    // Only the armed case needs a holding screen; everyone else renders at once.
    return hasDeviceLock() && user ? (
      <div className="min-h-dvh bg-cream" aria-hidden />
    ) : (
      <>{children}</>
    );
  }
  if (!locked) return <>{children}</>;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-cream px-6 text-center">
      <span className="flex size-20 items-center justify-center rounded-full bg-accent-soft">
        <Fingerprint size={36} className="text-accent" />
      </span>
      <h1 className="mt-6 text-[22px] font-extrabold text-ink">{t("lock.title")}</h1>
      <p className="mt-2 max-w-[300px] text-[14px] text-cocoa">
        {failed
          ? t("lock.failed")
          : t("lock.prompt")}
      </p>

      <button
        onClick={unlock}
        disabled={busy}
        className="mt-7 h-[52px] w-full max-w-[320px] rounded-pill bg-accent text-[15px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy ? t("lock.waiting") : t("lock.unlock")}
      </button>

      {/* Always reachable: a sensor that stops working must never strand
          someone inside their own account with no way forward. Signing out
          clears the local credential too, so the next login is a clean one. */}
      <button
        onClick={async () => {
          forgetDeviceLock();
          await logout();
          window.location.href = "/login";
        }}
        className="mt-4 flex items-center gap-2 text-[14px] font-semibold text-cocoa hover:underline"
      >
        <LogOut size={15} /> {t("lock.signOut")}
      </button>
    </div>
  );
}
