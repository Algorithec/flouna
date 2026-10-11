"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Phone,
  Star,
  ShieldCheck,
  Navigation,
  Copy,
  Check,
  Share2,
  X,
  LifeBuoy,
  MessageCircle,
  Info,
  IndianRupee,
} from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/motion";
import { useI18n } from "@/components/i18n/I18nContext";

const LiveTrackingMap = dynamic(
  () => import("./LiveTrackingMap").then((m) => m.LiveTrackingMap),
  {
    ssr: false,
    loading: () => <div className="h-[300px] w-full animate-pulse bg-beige/50" />,
  },
);

type LatLng = { lat: number; lng: number };

type Driver = {
  name: string;
  phoneMasked: string;
  rating: number;
  trips: number;
  photoUrl: string | null;
  vehicle: { type: "bike" | "auto" | "cab"; model: string; plate: string; color: string };
};

type Tracking = {
  providerRef: string;
  state: "searching" | "assigned" | "arriving" | "arrived" | "in_progress" | "completed" | "cancelled";
  otp: string;
  driver: Driver | null;
  driverLocation: LatLng | null;
  pickupEtaMinutes: number;
  dropEtaMinutes: number;
  statusMessage: string;
};

const POLL_MS = 4000;

// Live fulfilment tracking — the same engine renders two very different
// experiences: a RIDE (captain, trip, start-OTP, cancellable while live) and a
// FOOD DELIVERY (Swiggy/Zomato model: preparing → out for delivery → delivered,
// delivery partner, handover OTP, cancellable only until pickup, help instead
// of trip-sharing). Never let ride language leak into a food order.
export function RideTracker({
  orderId,
  pickup,
  drop,
  pickupLabel,
  dropLabel,
  farePaise,
  domain = "ride",
  onCancelRequest,
  onTrackingUpdate,
}: {
  orderId: string;
  pickup: LatLng;
  drop: LatLng;
  pickupLabel?: string;
  dropLabel: string;
  farePaise?: number;
  domain?: "ride" | "food";
  /** Cancelling is one dialog, owned by the order page (CancelOrderSheet) —
   *  this just asks for it, so there's never a second cancel UI competing
   *  with the page-level one. */
  onCancelRequest?: () => void;
  /** Reports the live driver name + pickup ETA up so the cancel dialog can
   *  show "Driver is only 3 min away" without polling /track a second time. */
  onTrackingUpdate?: (info: { driverName: string | null; etaMinutes: number | null }) => void;
}) {
  const isFood = domain === "food";
  const { t: tr } = useI18n();
  const [t, setT] = useState<Tracking | null>(null);
  // True while fulfilment is simulated (pilot before ONDC onboarding). The
  // driver, OTP and vehicle below are invented, so the rider is told.
  const [simulated, setSimulated] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api<{ tracking: Tracking; simulated?: boolean }>(`/api/orders/${orderId}/track`)
        .then((d) => {
          if (stop) return;
          setT(d.tracking);
          setSimulated(Boolean(d.simulated));
        })
        .catch(() => {});
    load();
    timer.current = setInterval(load, POLL_MS);
    return () => {
      stop = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [orderId]);

  // Stop polling once the fulfilment reaches a terminal state.
  useEffect(() => {
    if ((t?.state === "completed" || t?.state === "cancelled") && timer.current)
      clearInterval(timer.current);
  }, [t?.state]);

  useEffect(() => {
    onTrackingUpdate?.({
      driverName: t?.driver?.name ?? null,
      etaMinutes: t?.pickupEtaMinutes ?? null,
    });
    // onTrackingUpdate intentionally excluded — the parent's setState identity
    // isn't guaranteed stable, and re-running only when the tracking data
    // itself changes is the correct trigger here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.driver?.name, t?.pickupEtaMinutes]);

  const done = t?.state === "completed";
  const cancelled = t?.state === "cancelled";
  const searching = !t || t.state === "searching";
  const pickedUp = t?.state === "in_progress";
  // Rides: cancellable while live. Food: only until the partner picks it up
  // (mirrors the server's cut-off — the button disappears when it would 409).
  const canCancel = Boolean(t) && !done && !cancelled && (!isFood || !pickedUp);

  // All user-facing copy in one place, per domain — every string comes from the
  // localization layer (en/hi/te), for the ride AND food experiences alike.
  const L = isFood
    ? {
        searchingTitle: tr("track.food.preparing"),
        searchingSub: tr("track.food.preparingSub"),
        headingTitle: tr("track.food.preparing"),
        arrivedTitle: tr("track.food.pickingUp"),
        onTheWayTitle: tr("track.food.outForDelivery"),
        minToDrop: tr("track.food.minToDoor"),
        doneTitle: tr("track.food.delivered"),
        doneSub: tr("track.food.enjoy"),
        cancelledTitle: tr("track.food.cancelled"),
        cancelledSub: tr("track.food.cancelledSub"),
        partnerLabel: tr("track.food.partner"),
        tripsNoun: tr("track.food.deliveries"),
        otpLabel: tr("track.food.otp"),
        cancelCta: tr("track.food.cancelOrder"),
      }
    : {
        searchingTitle: tr("track.searching"),
        searchingSub: "",
        headingTitle: tr("track.onTheWay"),
        arrivedTitle: tr("track.arrived"),
        onTheWayTitle: tr("track.onTheWay"),
        minToDrop: tr("track.minToDrop"),
        doneTitle: tr("track.completed"),
        doneSub: tr("track.enjoyed"),
        cancelledTitle: tr("track.cancelled"),
        cancelledSub: tr("track.cancelledSub"),
        partnerLabel: "",
        tripsNoun: tr("track.trips"),
        otpLabel: tr("track.startOtp"),
        cancelCta: tr("track.cancelRide"),
      };

  async function shareTrip() {
    const url = `${window.location.origin}/orders/${orderId}`;
    const text = tr("track.shareText");
    try {
      if (navigator.share) {
        await navigator.share({ title: "Flouna", text, url });
      } else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // user dismissed the share sheet
    }
  }

  // Header title + sub, per state and domain.
  const title = cancelled
    ? L.cancelledTitle
    : done
      ? L.doneTitle
      : searching
        ? L.searchingTitle
        : t?.state === "in_progress"
          ? isFood
            ? L.onTheWayTitle
            : `${L.onTheWayTitle} · ${dropLabel}`
          : t?.state === "arrived"
            ? L.arrivedTitle
            : L.headingTitle;
  const sub = cancelled
    ? L.cancelledSub
    : done
      ? L.doneSub
      : t?.state === "in_progress"
        ? `${t.dropEtaMinutes} ${L.minToDrop}`
        : searching && isFood
          ? L.searchingSub
          : t?.statusMessage ?? "…";

  return (
    <FadeIn y={10}>
      {/* Pilot running on simulated fulfilment: the driver and vehicle shown
          below are not real, and saying so is the condition on which the
          production gate allows this mode at all. */}
      {simulated && (
        <div className="mb-3 flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>
            <strong className="font-semibold">
              {isFood ? tr("rt.demoDelivery") : tr("rt.demoRide")}
            </strong>{" "}
            {isFood ? tr("rt.simFood") : tr("rt.simRide")}
          </span>
        </div>
      )}

      <Card className="overflow-hidden p-0">
        {/* Status header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft">
              <Navigation size={15} className="text-accent" />
            </span>
            <div>
              <p className="text-[13px] font-bold text-ink">{title}</p>
              <p className="text-[11px] text-cocoa">{sub}</p>
            </div>
          </div>
          {!done && !cancelled && (
            <span className="flex items-center gap-1.5 rounded-pill bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
              <span className="size-1.5 animate-pulse rounded-full bg-success" /> {tr("track.live")}
            </span>
          )}
        </div>

        {/* Map */}
        <div className="h-[280px] w-full border-y border-line">
          <LiveTrackingMap
            pickup={pickup}
            drop={drop}
            driverLocation={t?.driverLocation ?? null}
            done={Boolean(done)}
            vehicle={isFood ? "bike" : "car"}
          />
        </div>

        {/* Ride confirmed banner (Figma) — pre-trip reassurance for rides */}
        {!isFood && !done && !cancelled && t && ["searching", "arriving", "arrived"].includes(t.state) && (
          <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-card border border-success/40 bg-success/5 px-3.5 py-2.5">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
            <div className="min-w-0">
              <p className="text-[13px] font-bold text-success">{tr("rt.confirmed")}</p>
              <p className="text-[11.5px] text-cocoa">
                {tr("rt.trackLive")}
              </p>
            </div>
          </div>
        )}

        {/* Trip Details (Figma "Ride Completed") — pickup, drop and the final
            fare, once there's a finished trip to summarise. Rating lives in
            RateOrder below rather than duplicated here. */}
        {!isFood && done && (
          <div className="mx-4 mt-3 rounded-card border border-line">
            <p className="flex items-center gap-1.5 border-b border-line px-3.5 py-3 text-[13px] font-bold text-ink">
              <span className="size-1.5 rounded-full bg-ink" /> {tr("rt.tripDetails")}
            </p>
            <div className="flex items-center gap-3 border-b border-line/70 px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                <Navigation size={14} className="text-ink" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] text-cocoa">{tr("bill.pickup")}</p>
                <p className="truncate text-[14px] font-bold text-ink">
                  {pickupLabel ?? tr("bill.pickup")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 border-b border-line/70 px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                <Navigation size={14} className="rotate-180 text-ink" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] text-cocoa">{tr("bill.drop")}</p>
                <p className="truncate text-[14px] font-bold text-ink">{dropLabel}</p>
              </div>
            </div>
            {farePaise != null && (
              <div className="flex items-center gap-3 px-3.5 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                  <IndianRupee size={14} className="text-ink" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] text-cocoa">{tr("rt.totalFare")}</p>
                  <p className="text-[14px] font-bold text-ink">{rupees(farePaise)}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Searching shimmer or partner card */}
        {searching ? (
          <div className="px-4 py-4">
            <div className="flex items-center gap-3">
              <div className="size-12 shrink-0 animate-pulse rounded-full bg-beige" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-1/2 animate-pulse rounded bg-beige" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-beige" />
              </div>
            </div>
            {canCancel && onCancelRequest && (
              <button
                onClick={onCancelRequest}
                className="mt-3 w-full rounded-pill border border-danger/40 bg-card py-2.5 text-[12px] font-semibold text-danger transition-colors hover:bg-danger/5"
              >
                {L.cancelCta}
              </button>
            )}
          </div>
        ) : cancelled ? null : (
          t?.driver && (
            <div className="px-4 py-4">
              {isFood && (
                <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                  {L.partnerLabel}
                </p>
              )}
              <div className="flex items-center gap-3">
                <span
                  className="flex size-12 shrink-0 items-center justify-center rounded-full text-[18px] font-bold text-white"
                  style={{ background: "linear-gradient(135deg,#ff8a4c,#e8651a)" }}
                >
                  {t.driver.name[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
                    {t.driver.name}
                    <span className="flex items-center gap-0.5 text-[11px] font-semibold text-cocoa">
                      <Star size={11} className="fill-accent text-accent" />
                      {t.driver.rating.toFixed(1)}
                    </span>
                  </p>
                  <p className="truncate text-[12px] text-cocoa">
                    {t.driver.vehicle.color} {t.driver.vehicle.model} ·{" "}
                    {t.driver.trips.toLocaleString("en-IN")} {L.tripsNoun}
                  </p>
                </div>
                {/* Number plate — ride identification only; meaningless for food */}
                {!isFood && (
                  <span className="shrink-0 rounded-md border border-line bg-beige/60 px-2 py-1 text-[12px] font-bold tracking-wide text-ink">
                    {t.driver.vehicle.plate}
                  </span>
                )}
              </div>

              {/* OTP + call row */}
              {!done && (
                <div className="mt-3 flex items-center gap-2.5">
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(t.otp).then(
                        () => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        },
                        () => {},
                      );
                    }}
                    className="flex flex-1 items-center justify-between rounded-card border border-accent/40 bg-accent-soft/60 px-3 py-2.5"
                  >
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-cocoa">
                      <ShieldCheck size={13} className="text-accent" /> {L.otpLabel}
                    </span>
                    <span className="flex items-center gap-1.5 text-[18px] font-bold tracking-[0.2em] text-ink">
                      {t.otp}
                      {copied ? (
                        <Check size={14} className="text-success" />
                      ) : (
                        <Copy size={13} className="text-cocoa/60" />
                      )}
                    </span>
                  </button>
                  <a
                    href="tel:"
                    onClick={(e) => e.preventDefault()}
                    title={t.driver.phoneMasked}
                    aria-label={tr("rt.call")}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink-fill text-white transition-transform hover:scale-105"
                  >
                    <Phone size={17} />
                  </a>
                  {/* Was an anchor to "sms:" with its default prevented: a
                      button that looked live and did nothing. */}
                  <Link
                    href={`/orders/${orderId}/chat`}
                    aria-label={`Message ${t.driver.name}`}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-card text-ink transition-transform hover:scale-105"
                  >
                    <MessageCircle size={17} />
                  </Link>
                </div>
              )}
              {isFood && !done && (
                <p className="mt-1.5 text-[10.5px] text-muted">
                  {tr("track.food.otpHint")}
                </p>
              )}

              {/* Actions: food → Help (+ Cancel until pickup) · ride → Share (+ Cancel) */}
              <div className="mt-2.5 flex items-center gap-2.5">
                {isFood ? (
                  <Link
                    href={`/profile/help?order=${orderId}`}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-line bg-card py-2.5 text-[12px] font-semibold text-ink transition-colors hover:bg-beige/40"
                  >
                    <LifeBuoy size={14} className="text-accent" /> {tr("track.food.getHelp")}
                  </Link>
                ) : (
                  (canCancel || done) && (
                    <button
                      onClick={shareTrip}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-line bg-card py-2.5 text-[12px] font-semibold text-ink transition-colors hover:bg-beige/40"
                    >
                      <Share2 size={14} className="text-accent" /> {tr("track.share")}
                    </button>
                  )
                )}
                {canCancel && onCancelRequest && (
                  <button
                    onClick={onCancelRequest}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-danger/40 bg-card py-2.5 text-[12px] font-semibold text-danger transition-colors hover:bg-danger/5"
                  >
                    <X size={14} /> {L.cancelCta}
                  </button>
                )}
              </div>
            </div>
          )
        )}
      </Card>
    </FadeIn>
  );
}
