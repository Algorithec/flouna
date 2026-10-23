"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Headset, Loader2, MapPin, Navigation, Phone } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { useBackTo } from "@/lib/navHistory";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { ErrorView, LoadingView } from "@/components/ui/StatusView";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";

// One ride with an ONDC ride provider, from the fare to the end of the trip.
//
// The provider answers each step a few seconds later and sends updates as
// the ride moves, so while it is waiting on the provider this screen asks
// again every couple of seconds, and every ten while a booked ride is under
// way. What it offers next depends only on where the server says the ride
// stands. The provider collects the fare, so there is no payment step here.

type RideView = {
  id: string;
  status: string;
  problem: string | null;
  pickup: { address: string };
  drop: { address: string };
  vehicle: string | null;
  farePaise: number | null;
  cancelFeePaise: number | null;
  rideState: string | null;
  driver: { name?: string; phone?: string } | null;
  vehicleInfo: { registration?: string; make?: string; model?: string; color?: string } | null;
  startOtp: string | null;
  tracking: { url?: string; gps?: string } | null;
};

const WAITING = new Set(["searching", "selecting", "initialising", "confirming", "cancel_quoting", "cancelling"]);
const REASONS = ["001", "002", "003", "004"] as const;
const PILL = "tap-target inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill px-4 py-2 text-center text-[14px] font-semibold leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const SOFT = `${PILL} bg-beige text-ink hover:bg-beige-hover`;
const MAIN = `${PILL} bg-btn text-white hover:bg-btn-hover`;

export default function OndcRidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const goBack = useBackTo("/rides");
  const [ride, setRide] = useState<RideView | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState<string | null>(null);
  const [askWhy, setAskWhy] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("001");
  useEscapeToClose(askWhy && !busy, () => setAskWhy(false));

  // Keys built from what the provider sent; a state with no wording yet shows the provider's own word.
  const tr = (key: string, fallback: string) => {
    const said = t(key as TranslationKey);
    return said === key ? fallback : said;
  };

  const load = useCallback(
    () =>
      api<RideView>(`/api/ondc/rides/${id}`).then(setRide, () => {
        setMissing(true);
      }),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!ride) return;
    const under = ride.status === "booked" || ride.status === "cancel_quoted";
    if (!WAITING.has(ride.status) && !under) return;
    const timer = setTimeout(() => void load(), WAITING.has(ride.status) ? 2000 : 10000);
    return () => clearTimeout(timer);
  }, [ride, load]);

  async function step(path: string, json?: unknown) {
    setBusy(true);
    setActionFailed(null);
    try {
      await api(`/api/ondc/rides/${id}/${path}`, { method: "POST", ...(json ? { json } : {}) });
      await load();
      return true;
    } catch (err) {
      setActionFailed(err instanceof Error && err.message ? err.message : t("or.failedAction"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (missing) return <ErrorView notFound title={t("or.notFound")} backHref="/rides" />;
  if (!ride) return <LoadingView rows={4} />;

  const waiting = WAITING.has(ride.status);
  const v = ride.vehicleInfo;

  return (
    <div className="min-h-dvh bg-acct-bg">
      <div className="mx-auto w-full max-w-xl px-4 pb-10 lg:max-w-[780px] lg:px-6">
        <div className="flex items-center py-4">
          <button onClick={goBack} aria-label={t("common.back")} className="tap-target flex size-9 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-acct-bg">
            <ArrowLeft size={18} className="text-acct-ink" />
          </button>
          <h1 className="flex-1 text-center text-[17px] font-extrabold text-acct-ink">{t("or.pageTitle")}</h1>
          <span className="size-9" />
        </div>

        <section className="rounded-[18px] bg-card p-4 shadow-soft">
          <div className="flex items-center gap-2" role="status" aria-live="polite">
            {waiting && <Loader2 size={16} className="shrink-0 animate-spin text-accent" />}
            <p className="text-[17px] font-bold text-acct-ink">{tr(`or.s.${ride.status}`, ride.status)}</p>
          </div>
          {ride.rideState && ride.status === "booked" && <p className="mt-1 text-[13px] text-acct-muted">{tr(`or.rs.${ride.rideState}`, ride.rideState)}</p>}
          {ride.problem && !waiting && <p className="mt-2 text-[13px] leading-relaxed text-danger">{ride.problem}</p>}
          {ride.status === "cancel_quoted" && (
            <p className="mt-2 text-[14px] font-semibold text-acct-ink">
              {ride.cancelFeePaise ? t("or.fee").replace("{amount}", rupees(ride.cancelFeePaise)) : t("or.feeFree")}
            </p>
          )}
          {waiting && <p className="mt-2 text-[12px] text-acct-muted">{t("or.stepNote")}</p>}
        </section>

        <section className="mt-3 space-y-2 rounded-[18px] bg-card p-4 shadow-soft">
          <p className="flex gap-2 text-[13px] text-acct-ink">
            <MapPin size={15} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0">
              <span className="block text-[11px] text-acct-muted">{t("or.from")}</span>
              {ride.pickup.address}
            </span>
          </p>
          <p className="flex gap-2 text-[13px] text-acct-ink">
            <Navigation size={15} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0">
              <span className="block text-[11px] text-acct-muted">{t("or.to")}</span>
              {ride.drop.address}
            </span>
          </p>
          {ride.farePaise != null && (
            <div className="flex items-baseline justify-between border-t border-line pt-2">
              <span className="text-[13px] text-acct-muted">{t("or.fare")}</span>
              <span className="text-[17px] font-bold text-acct-ink">{rupees(ride.farePaise)}</span>
            </div>
          )}
          {ride.farePaise != null && ["quoted", "ready", "booked"].includes(ride.status) && <p className="text-[12px] text-acct-muted">{t("or.payDriver")}</p>}
        </section>

        {ride.status === "booked" && (ride.driver || v || ride.startOtp) && (
          <section className="mt-3 rounded-[18px] bg-card p-4 shadow-soft">
            {ride.startOtp && (
              <div className="mb-3 rounded-[12px] bg-accent-soft px-3 py-2.5 text-center">
                <p className="text-[12px] text-acct-ink">{t("or.otp")}</p>
                <p className="mt-0.5 text-[24px] font-extrabold tracking-[0.3em] text-acct-ink">{ride.startOtp}</p>
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1">
                {ride.driver?.name && <span className="block truncate text-[15px] font-bold text-acct-ink">{ride.driver.name}</span>}
                {v && <span className="block truncate text-[13px] text-acct-muted">{[v.registration, [v.color, v.make, v.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}</span>}
              </span>
              {ride.driver?.phone && (
                <a href={`tel:${ride.driver.phone}`} className={`${SOFT} shrink-0`}>
                  <Phone size={15} /> {t("or.call")}
                </a>
              )}
            </div>
          </section>
        )}

        <div className="mt-4 space-y-2">
          {ride.status === "quoted" && (
            <button type="button" className={`${MAIN} w-full`} disabled={busy} onClick={() => void step("init")}>
              {t("or.continue")}
            </button>
          )}
          {ride.status === "ready" && (
            <button type="button" className={`${MAIN} w-full`} disabled={busy} onClick={() => void step("confirm")}>
              {t("or.confirm")}
            </button>
          )}
          {ride.status === "booked" && (
            <>
              <div className="flex gap-2">
                <button type="button" className={`${SOFT} flex-1`} disabled={busy} onClick={() => void step("status")}>
                  {t("or.checkStatus")}
                </button>
                {ride.tracking?.url || ride.tracking?.gps ? (
                  <a
                    href={ride.tracking.url ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ride.tracking.gps!.replace(/\s/g, ""))}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${SOFT} flex-1`}
                  >
                    {t("or.openMap")}
                  </a>
                ) : (
                  <button type="button" className={`${SOFT} flex-1`} disabled={busy} onClick={() => void step("track")}>
                    {t("or.track")}
                  </button>
                )}
              </div>
              {ride.rideState !== "RIDE_STARTED" && (
                <button type="button" className={`${PILL} w-full text-danger hover:bg-beige/60`} disabled={busy} onClick={() => setAskWhy(true)}>
                  {t("or.cancel")}
                </button>
              )}
            </>
          )}
          {ride.status === "cancel_quoted" && (
            <div className="flex gap-2">
              <button type="button" className={`${SOFT} flex-1`} disabled={busy} onClick={() => void step("cancel/keep")}>
                {t("or.keep")}
              </button>
              <button type="button" className={`${PILL} flex-1 bg-accent text-white hover:bg-[#d4570f]`} disabled={busy} onClick={() => void step("cancel/confirm")}>
                {t("or.cancel")}
              </button>
            </div>
          )}
          {/* A booked, finished or cancelled ride is one the rider can complain about. */}
          {["booked", "completed", "cancelled"].includes(ride.status) && (
            <Link href={`/orders/${ride.id}/help`} className={`${PILL} w-full text-ink hover:bg-beige/60`}>
              <Headset size={15} /> {t("history.needHelp")}
            </Link>
          )}
          {actionFailed && <p className="text-center text-[13px] text-danger">{actionFailed}</p>}
        </div>
      </div>

      {askWhy && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => !busy && setAskWhy(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="or-why" className="w-full max-w-md rounded-t-[22px] bg-card p-5 sm:rounded-[22px]" onClick={(e) => e.stopPropagation()}>
            <h2 id="or-why" className="text-[16px] font-bold text-acct-ink">{t("or.cancelWhy")}</h2>
            <div className="mt-3 space-y-1.5">
              {REASONS.map((r) => (
                <label key={r} className="tap-target flex cursor-pointer items-center gap-3 rounded-[12px] border border-line px-3 py-2.5 text-[14px] text-acct-ink has-[:checked]:border-accent">
                  <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} className="accent-accent" />
                  {t(`or.r.${r}` as TranslationKey)}
                </label>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" className={`${SOFT} flex-1`} disabled={busy} onClick={() => setAskWhy(false)}>
                {t("or.keep")}
              </button>
              {/* Asks the fee only; nothing is cancelled until the rider sees it and confirms. */}
              <button
                type="button"
                className={`${PILL} flex-1 bg-accent text-white hover:bg-[#d4570f]`}
                disabled={busy}
                onClick={async () => {
                  if (await step("cancel", { reasonId: reason })) setAskWhy(false);
                }}
              >
                {t("or.askFee")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
