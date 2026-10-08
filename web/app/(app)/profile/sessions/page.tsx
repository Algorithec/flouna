"use client";

import { useCallback, useEffect, useState } from "react";
import { useBackTo } from "@/lib/navHistory";
import { ArrowLeft, Monitor, Smartphone, LogOut } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/cn";

// Privacy & Security → Login Activity.
//
// Backed by the refresh tokens that already are the sessions, so signing one
// out here genuinely ends it rather than hiding a row. Which row is the current
// device comes from a separate call: the refresh cookie is scoped to
// /api/auth for CSRF defence, so only that router can answer it.

type Session = {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  userAgent: string | null;
};

/** Same coarse read the server does, for the icon only. */
function isPhone(ua: string | null) {
  return !!ua && /iPhone|Android|iPad|Mobile/i.test(ua);
}

function describe(ua: string | null, unknown: string) {
  if (!ua) return unknown;
  const browser =
    /EdgA?\//.test(ua) ? "Edge"
    : /OPR\/|Opera\//.test(ua) ? "Opera"
    : /SamsungBrowser\//.test(ua) ? "Samsung Internet"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /CriOS\/|Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : null;
  const platform =
    /Windows NT/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : null;
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? unknown;
}

function when(iso: string | null, t: (k: TranslationKey) => string, locale: string) {
  if (!iso) return "Unknown";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return t("pp.sess.justNow");
  if (mins < 60) return `${mins} ${t("pp.sess.minAgo")}`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} ${t("pp.sess.hrAgo")}`;
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

export default function LoginActivityPage() {
  const goBack = useBackTo("/profile/privacy");
  const { toast } = useToast();
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-IN" : `${lang}-IN`;
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ sessions: Session[] }>("/api/users/sessions")
      .then((d) => setSessions(d.sessions))
      .catch(() => setSessions([]));
    api<{ currentId: string | null }>("/api/auth/sessions/current")
      .then((d) => setCurrentId(d.currentId))
      .catch(() => setCurrentId(null));
  }, []);
  useEffect(load, [load]);

  async function signOut(id: string) {
    const previous = sessions;
    setSessions((s) => s?.filter((x) => x.id !== id) ?? null);
    try {
      await api(`/api/auth/sessions/${id}`, { method: "DELETE" });
      toast(t("pp.sess.signedOutOne"));
    } catch (err) {
      setSessions(previous ?? null);
      toast(err instanceof Error ? err.message : t("pp.sess.signOutOneFailed"));
    }
  }

  async function signOutOthers() {
    setBusy(true);
    try {
      const d = await api<{ revoked: number }>("/api/auth/sessions/revoke-others", {
        method: "POST",
      });
      load();
      toast(
        d.revoked > 0
          ? d.revoked === 1
            ? t("pp.sess.signedOutOther")
            : t("pp.sess.signedOutOthers").replace("{n}", String(d.revoked))
          : t("pp.sess.noneActive"),
      );
    } catch {
      toast(t("pp.sess.signOutFailed"));
    } finally {
      setBusy(false);
    }
  }

  const others = (sessions ?? []).filter((s) => s.id !== currentId).length;

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
            {t("pp.priv.loginActivity")}
          </h1>
        </div>

        <div className="overflow-hidden rounded-[18px] bg-card shadow-soft">
          {sessions === null ? (
            <p className="px-4 py-8 text-center text-[13px] text-acct-muted">
              {t("common.loading")}
            </p>
          ) : sessions.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-acct-muted">
              {t("pp.sess.none")}
            </p>
          ) : (
            sessions.map((s) => {
              const current = s.id === currentId;
              const Icon = isPhone(s.userAgent) ? Smartphone : Monitor;
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0"
                >
                  <span
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-full",
                      current ? "bg-success-soft" : "bg-acct-tint",
                    )}
                  >
                    <Icon size={17} className={current ? "text-success" : "text-acct-accent"} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-bold text-acct-ink">
                        {describe(s.userAgent, t("pp.sess.unknownDevice"))}
                      </span>
                      {current && (
                        <span className="shrink-0 rounded-pill bg-success/10 px-2 py-0.5 text-[10px] font-bold text-success">
                          {t("pp.sess.thisDevice")}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-acct-muted">
                      {t("pp.sess.signedIn")} {when(s.createdAt, t, locale)} ·{" "}
                      {t("pp.sess.lastActive")} {when(s.lastUsedAt ?? s.createdAt, t, locale)}
                    </span>
                  </span>
                  {!current && (
                    <button
                      onClick={() => signOut(s.id)}
                      className="tap-target shrink-0 rounded-pill border border-line px-3 py-1.5 text-[12px] font-semibold text-acct-ink transition-colors hover:bg-danger-soft hover:text-danger"
                    >
                      {t("pp.sess.signOut")}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {others > 0 && (
          <button
            disabled={busy}
            onClick={signOutOthers}
            className="mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-pill border border-line bg-card text-[15px] font-bold text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
          >
            <LogOut size={17} />
            {busy ? t("pp.sess.signingOut") : t("pp.sess.signOutOthers")}
          </button>
        )}

        <p className="mt-4 px-1 text-[12px] leading-relaxed text-acct-muted">
          {t("pp.sess.footer")}
        </p>
      </div>
    </div>
  );
}
