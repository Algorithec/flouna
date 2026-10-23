"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Info } from "lucide-react";
import { api, ApiClientError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { listenForShake, OPEN_REPORT_EVENT, setShakeEnabled, shakeSupported, useShakeEnabled } from "@/lib/shake";

// "Report a technical problem", after Instagram's sheet: shake the phone (or
// pick it in Settings) and say what went wrong. It becomes a support ticket in
// the "technical" category, with the page and device attached so the team can
// reproduce it. Abuse, orders and safety go to Help instead, which is where
// they get the published grievance handling.

type Step = "intro" | "form" | "sent";

export function ReportProblem() {
  const { t, lang } = useI18n();
  const pathname = usePathname();
  const shakeOn = useShakeEnabled();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("intro");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [openedBy, setOpenedBy] = useState<"shake" | "menu">("menu");

  function show(by: "shake" | "menu") {
    setOpenedBy(by);
    setStep("intro");
    setError("");
    setOpen(true);
  }

  useEffect(() => {
    const onOpen = () => show("menu");
    window.addEventListener(OPEN_REPORT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_REPORT_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!shakeOn || open) return;
    return listenForShake(() => show("shake"));
  }, [shakeOn, open]);

  const close = () => {
    if (busy) return;
    setOpen(false);
    if (step === "sent") setText("");
  };
  useEscapeToClose(open && !busy, close);

  async function send() {
    const description = text.trim();
    if (description.length < 5) {
      setError(t("rp.tooShort"));
      return;
    }
    setBusy(true);
    setError("");
    // Only the path: a query string can carry a chat or order id the person
    // did not mean to share.
    const details = [
      `Page: ${pathname}`,
      `Browser: ${navigator.userAgent}`,
      `Screen: ${window.innerWidth}x${window.innerHeight}`,
      `Language: ${lang}`,
      `Opened by: ${openedBy}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    try {
      const res = await api<{ ticket: { id: string } }>("/api/users/tickets", {
        method: "POST",
        json: {
          category: "technical",
          subject: `Technical problem on ${pathname}`.slice(0, 140),
          body: `${description.slice(0, 1500)}\n\n${details}`.slice(0, 2000),
        },
      });
      setTicketId(res.ticket.id.slice(-6).toUpperCase());
      setStep("sent");
    } catch (err) {
      setError(err instanceof ApiClientError && err.status === 401 ? t("rp.signIn") : t("rp.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t("rp.title")}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-md rounded-t-[32px] bg-auth-bg px-6 pb-8 pt-3 shadow-lift sm:rounded-[32px] sm:pt-6">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line sm:hidden" aria-hidden />
        <p className="text-center text-[20px] font-bold text-ink">{t("rp.title")}</p>

        {step === "intro" && (
          <>
            <p className="mx-auto mt-2 max-w-[340px] text-center text-[14px] text-cocoa">{t("rp.intro")}</p>
            <button
              onClick={() => setStep("form")}
              className="tap-target mt-5 w-full rounded-pill bg-accent py-3 text-[15px] font-bold text-white transition-opacity hover:opacity-90"
            >
              {t("rp.report")}
            </button>

            <Link
              href="/profile/help"
              onClick={() => setOpen(false)}
              className="mt-5 flex items-center gap-3 rounded-[16px] py-1 text-left"
            >
              <Info size={20} className="shrink-0 text-ink" />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium text-ink">{t("rp.abuseTitle")}</span>
                <span className="mt-0.5 block text-[13px] text-cocoa">{t("rp.abuseBody")}</span>
              </span>
              <ChevronRight size={18} className="shrink-0 text-muted" />
            </Link>

            {shakeSupported() && (
              <div className="mt-5 flex items-center gap-3 border-t border-line/70 pt-4">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink">{t("rp.shakeToggle")}</p>
                  <p className="text-[12px] text-cocoa">{t("rp.shakeHint")}</p>
                </div>
                <Switch on={shakeOn} label={t("rp.shakeToggle")} onToggle={() => void setShakeEnabled(!shakeOn)} />
              </div>
            )}
          </>
        )}

        {step === "form" && (
          <>
            <label htmlFor="rp-text" className="mt-4 block text-[14px] font-medium text-ink">
              {t("rp.describe")}
            </label>
            <textarea
              id="rp-text"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={1500}
              rows={5}
              placeholder={t("rp.placeholder")}
              className="mt-2 w-full resize-none rounded-[16px] border border-line bg-card px-4 py-3 text-[15px] text-ink outline-none focus:border-accent"
            />
            <p className="mt-2 text-[12px] text-cocoa">{t("rp.diagnostics")}</p>
            {error && (
              <p role="alert" className="mt-2 text-[13px] text-danger">
                {error}
              </p>
            )}
            <div className="mt-4 flex gap-3">
              <button
                onClick={close}
                disabled={busy}
                className="tap-target flex-1 rounded-pill border border-line py-3 text-[15px] font-semibold text-ink disabled:opacity-50"
              >
                {t("rp.close")}
              </button>
              <button
                onClick={send}
                disabled={busy}
                className="tap-target flex-1 rounded-pill bg-accent py-3 text-[15px] font-bold text-white disabled:opacity-60"
              >
                {busy ? t("rp.sending") : t("rp.send")}
              </button>
            </div>
          </>
        )}

        {step === "sent" && (
          <>
            <p className="mx-auto mt-3 max-w-[340px] text-center text-[14px] text-cocoa">
              {t("rp.sent").replace("{id}", ticketId)}
            </p>
            <button
              onClick={close}
              className="tap-target mt-5 w-full rounded-pill bg-accent py-3 text-[15px] font-bold text-white"
            >
              {t("rp.close")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function Switch({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "tap-target h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-50",
        on ? "bg-accent" : "bg-line",
      )}
    >
      <span className={cn("block size-5 rounded-full bg-white shadow transition-transform", on && "translate-x-5")} />
    </button>
  );
}
