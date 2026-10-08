"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { useCallback, useEffect, useState } from "react";
import { Download, Cookie, Brain, Trash2, ScrollText, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { SubPage } from "@/components/profile/SubPage";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

// Your data. The rights the privacy policy grants, in one place.
//
// Privacy & Security next door is about who can see you. This is about what we
// hold and what you can make us do with it, which is a different question and
// answers to different sections of the policy: 6.1 a copy, 6.2 erasure, 6.4
// exclusion from training, and the cookie policy for the categories.
//
// Every control here is real. A settings screen that shows a toggle for a
// right nobody implemented is worse than not offering it, because the person
// walks away believing they exercised it.

type CookieChoice = {
  analytics: boolean;
  advertising: boolean;
  social: boolean;
  performance: boolean;
};

type CookieInfo = {
  chosenAt: string | null;
  choice: CookieChoice;
  inUse: { name: string; category: string; purpose: string }[];
};

type ConsentRow = {
  id: string;
  kind: string;
  granted: boolean;
  version: string | null;
  createdAt: string;
};

const CATEGORY_COPY: Record<keyof CookieChoice, { label: TranslationKey; sub: TranslationKey }> = {
  analytics: { label: "ck.analytics", sub: "ck.analyticsSub" },
  advertising: { label: "ck.advertising", sub: "ck.advertisingSub" },
  social: { label: "ck.social", sub: "ck.socialSub" },
  performance: { label: "ck.performance", sub: "ck.performanceSub" },
};

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
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
      onClick={() => onChange(!checked)}
      className={cn(
        "tap-target h-[30px] w-[52px] shrink-0 rounded-full transition-colors",
        checked ? "bg-acct-accent" : "bg-switch-off",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <span
        className={cn(
          "block size-[24px] rounded-full bg-white transition-transform",
          checked ? "translate-x-[25px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 rounded-2xl border border-acct-line bg-acct-card p-4">
      <h2 className="flex items-center gap-2 text-[15px] font-bold text-acct-ink">
        <span className="text-acct-accent">{icon}</span>
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function YourDataPage() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [cookies, setCookies] = useState<CookieInfo | null>(null);
  const [training, setTraining] = useState<boolean | null>(null);
  const [deletion, setDeletion] = useState<{ scheduledFor: string | null } | null>(null);
  const [consents, setConsents] = useState<ConsentRow[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Not async, so the state lands in a promise callback rather than
  // synchronously inside the effect, which is what the rest of the account
  // screens do and what React 19 wants.
  const load = useCallback(() => {
    api<{
      cookies: CookieInfo;
      aiTrainingOptOut: boolean;
      deletion: { scheduledFor: string | null };
    }>("/api/privacy/overview")
      .then((o) => {
        setCookies(o.cookies);
        setTraining(o.aiTrainingOptOut);
        setDeletion(o.deletion);
      })
      .catch(() => toast(t("dt.loadFailed")));
  }, [toast, t]);
  useEffect(load, [load]);

  async function saveCookies(next: CookieChoice) {
    // Optimistic, then reconciled. A consent toggle that lags feels broken,
    // and a person poking at it repeatedly is not giving clearer consent.
    const previous = cookies;
    setCookies((c) => (c ? { ...c, choice: next } : c));
    try {
      await api("/api/privacy/cookies", { method: "PUT", json: next });
    } catch {
      setCookies(previous);
      toast(t("dt.saveFailed"));
    }
  }

  async function saveTraining(optOut: boolean) {
    const previous = training;
    setTraining(optOut);
    try {
      await api("/api/privacy/ai-training", { method: "PUT", json: { optOut } });
      toast(optOut ? t("dt.excluded") : t("dt.optOutRemoved"));
    } catch {
      setTraining(previous);
      toast(t("dt.saveFailed"));
    }
  }

  // Fetched rather than linked. The endpoint needs the session cookie and
  // returns a file, and a plain anchor to it would open a tab that either
  // downloads or renders 70,000 characters of JSON depending on the browser.
  async function downloadExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/privacy/export", { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `flouna-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(t("dt.downloaded"));
    } catch {
      toast(t("dt.buildFailed"));
    } finally {
      setExporting(false);
    }
  }

  async function loadLog() {
    setShowLog(true);
    if (consents) return;
    try {
      const res = await api<{ consents: ConsentRow[] }>("/api/privacy/consents");
      setConsents(res.consents);
    } catch {
      toast(t("dt.consentFailed"));
    }
  }

  async function scheduleDeletion() {
    setBusy(true);
    try {
      const res = await api<{ scheduledFor: string }>("/api/privacy/deletion", {
        method: "POST",
        json: { password },
      });
      setDeletion({ scheduledFor: res.scheduledFor });
      setConfirming(false);
      setPassword("");
      toast(t("dt.scheduled"));
    } catch (err) {
      toast(err instanceof Error ? err.message : t("dt.scheduleFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function cancelDeletion() {
    setBusy(true);
    try {
      await api("/api/privacy/deletion", { method: "DELETE" });
      setDeletion({ scheduledFor: null });
      toast(t("dt.cancelled"));
    } catch {
      toast(t("dt.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }

  const scheduled = deletion?.scheduledFor
    ? new Date(deletion.scheduledFor).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <SubPage title={t("dt.title")}>
      <p className="text-[13px] leading-relaxed text-acct-muted">
        {t("dt.intro")}
      </p>

      {/* --- Cookies --- */}
      <Section icon={<Cookie size={17} />} title={t("dt.cookies")}>
        {cookies && (
          <>
            <div className="rounded-xl bg-acct-bg p-3">
              <p className="text-[12px] font-bold uppercase tracking-wide text-acct-muted">
                {t("dt.whatSets")}
              </p>
              <ul className="mt-2 space-y-1.5">
                {cookies.inUse.map((c) => (
                  <li key={c.name} className="text-[13px] leading-snug text-acct-ink">
                    <b>{c.name}</b>
                    <span className="text-acct-muted"> · {c.purpose}</span>
                  </li>
                ))}
              </ul>
              {/* Said plainly, because the policy reserves the right to more
                  categories than we currently use, and a preferences screen
                  that implies otherwise is a quiet untruth. */}
              <p className="mt-2.5 text-[12px] leading-snug text-acct-muted">
                {t("dt.cookieNote")}
              </p>
            </div>

            <div className="mt-3 divide-y divide-acct-line">
              {(Object.keys(CATEGORY_COPY) as (keyof CookieChoice)[]).map((key) => (
                <div key={key} className="flex items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-acct-ink">
                      {t(CATEGORY_COPY[key].label)}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-acct-muted">
                      {t(CATEGORY_COPY[key].sub)}
                    </span>
                  </span>
                  <Toggle
                    checked={cookies.choice[key]}
                    label={t(CATEGORY_COPY[key].label)}
                    onChange={(v) => saveCookies({ ...cookies.choice, [key]: v })}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      {/* --- Training --- */}
      <Section icon={<Brain size={17} />} title={t("dt.improving")}>
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-acct-ink">
              {t("dt.exclude")}
            </span>
            <span className="mt-0.5 block text-[12px] leading-snug text-acct-muted">
              {t("dt.excludeNote")}
            </span>
          </span>
          <Toggle
            checked={training === true}
            label={t("dt.exclude")}
            onChange={saveTraining}
            disabled={training === null}
          />
        </div>
      </Section>

      {/* --- Export --- */}
      <Section icon={<Download size={17} />} title={t("dt.copyTitle")}>
        <p className="text-[13px] leading-relaxed text-acct-muted">
          {t("dt.copyNote")}
        </p>
        <button
          type="button"
          onClick={downloadExport}
          disabled={exporting}
          className="tap-target mt-3 w-full rounded-xl bg-acct-accent px-4 py-3 text-[14px] font-bold text-white transition-opacity disabled:opacity-60"
        >
          {exporting ? t("dt.preparing") : t("dt.download")}
        </button>
      </Section>

      {/* --- Consent history --- */}
      <Section icon={<ScrollText size={17} />} title={t("dt.agreed")}>
        {!showLog ? (
          <button
            type="button"
            onClick={loadLog}
            className="tap-target text-[14px] font-bold text-acct-accent"
          >
            {t("dt.showHistory")}
          </button>
        ) : consents === null ? (
          <p className="text-[13px] text-acct-muted">{t("dp.loading")}</p>
        ) : (
          <ul className="divide-y divide-acct-line">
            {consents.map((c) => (
              <li key={c.id} className="flex items-baseline gap-3 py-2.5">
                <span className="min-w-0 flex-1 text-[13px] text-acct-ink">
                  {c.kind === "terms"
                    ? t("dt.kindTerms")
                    : c.kind === "cookies"
                      ? t("dt.kindCookies")
                      : c.kind === "ai_training"
                        ? t("dt.kindTraining")
                        : t("dt.kindMarketing")}
                  {c.version && (
                    <span className="text-acct-muted">
                      {" "}
                      · {t("dt.version").replace("{v}", c.version)}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-[12px] font-bold",
                    c.granted ? "text-acct-accent" : "text-acct-muted",
                  )}
                >
                  {c.granted ? t("dt.agreedState") : t("dt.withdrawn")}
                </span>
                <span className="shrink-0 text-[12px] text-acct-muted">
                  {new Date(c.createdAt).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* --- Deletion --- */}
      <Section icon={<Trash2 size={17} />} title={t("dt.deleteTitle")}>
        {scheduled ? (
          <div className="rounded-xl border border-danger/30 bg-danger/5 p-3.5">
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-acct-ink">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
              <span>
                {t("dt.scheduledOn").split("{date}")[0]}
                <b>{scheduled}</b>
                {t("dt.scheduledOn").split("{date}")[1]}
              </span>
            </p>
            <button
              type="button"
              onClick={cancelDeletion}
              disabled={busy}
              className="tap-target mt-3 w-full rounded-xl bg-acct-accent px-4 py-3 text-[14px] font-bold text-white disabled:opacity-60"
            >
              {t("dt.keep")}
            </button>
          </div>
        ) : !confirming ? (
          <>
            <p className="text-[13px] leading-relaxed text-acct-muted">
              {t("dt.holdNote")}
            </p>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="tap-target mt-3 w-full rounded-xl border border-danger/40 px-4 py-3 text-[14px] font-bold text-danger"
            >
              {t("dt.deleteTitle")}
            </button>
          </>
        ) : (
          <div className="rounded-xl border border-danger/30 bg-danger/5 p-3.5">
            <p className="text-[13px] leading-relaxed text-acct-ink">
              {t("dt.confirmNote")}
            </p>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("dt.yourPassword")}
              className="mt-3 w-full rounded-xl border border-acct-line bg-acct-card px-3.5 py-3 text-[16px] text-acct-ink outline-none focus:border-acct-accent"
            />
            <div className="mt-3 flex gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setPassword("");
                }}
                className="tap-target flex-1 rounded-xl border border-acct-line px-4 py-3 text-[14px] font-bold text-acct-ink"
              >
                {t("od.cancel")}
              </button>
              <button
                type="button"
                onClick={scheduleDeletion}
                disabled={busy || password.length === 0}
                className="tap-target flex-1 rounded-xl bg-danger px-4 py-3 text-[14px] font-bold text-white disabled:opacity-50"
              >
                {busy ? t("dt.working") : t("dt.confirm")}
              </button>
            </div>
          </div>
        )}
      </Section>
    </SubPage>
  );
}
