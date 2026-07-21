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
} from "lucide-react";
import { api } from "@/lib/api";
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
  dropLabel,
  domain = "ride",
}: {
  orderId: string;
  pickup: LatLng;
  drop: LatLng;
  dropLabel: string;
  domain?: "ride" | "food";
}) {
  const isFood = domain === "food";
  const { t: tr } = useI18n();
  const [t, setT] = useState<Tracking | null>(null);
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelSheet, setCancelSheet] = useState(false);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const [justCancelled, setJustCancelled] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api<{ tracking: Tracking }>(`/api/orders/${orderId}/track`)
        .then((d) => !stop && setT(d.tracking))
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
        keepCta: tr("track.food.keepOrder"),
        confirmCancelCta: tr("track.food.confirmCancel"),
        cancellingCta: tr("track.cancelling"),
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
        keepCta: tr("track.keepRide"),
        confirmCancelCta: tr("track.confirmCancel"),
        cancellingCta: tr("track.cancelling"),
      };

  async function cancelOrder(reason?: string) {
    setCancelling(true);
    setCancelError("");
    try {
      await api(`/api/orders/${orderId}/cancel`, {
        method: "POST",
        json: reason ? { reason } : {},
      });
      const d = await api<{ tracking: Tracking }>(`/api/orders/${orderId}/track`);
      setT(d.tracking);
      setCancelSheet(false);
      setJustCancelled(true); // fresh cancel → celebration panel
    } catch (e) {
      // Food past pickup (or any refusal): surface the server's reason.
      setCancelError(e instanceof Error ? e.message : "Couldn't cancel — try again.");
      setCancelSheet(false);
    } finally {
      setCancelling(false);
    }
  }

  // "Help us improve" reasons (Figma bottom sheet). Sent as the free-text
  // cancel reason; ops reads it on the order.
  const CANCEL_REASONS = [
    "Changed my plans",
    "Booked by mistake",
    "Found a better option",
    "Taking too long",
    "Other reason",
  ];

  async function shareTrip() {
    const url = `${window.location.origin}/orders/${orderId}`;
    const text = tr("track.shareText");
    try {
      if (navigator.share) {
        await navigator.share({ title: "Radiues", text, url });
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

  // Fresh cancel this session → the Figma "Booking Cancelled!" celebration.
  if (justCancelled) {
    return (
      <FadeIn y={10}>
        <Card className="flex flex-col items-center px-6 py-10 text-center">
          <span className="relative flex size-20 items-center justify-center rounded-full bg-success">
            <Check size={40} className="text-white" strokeWidth={3} />
            <span className="absolute -left-2 top-1 size-2 rounded-full bg-accent" />
            <span className="absolute -right-1 top-4 size-1.5 rounded-full bg-[#8b5cf6]" />
            <span className="absolute -bottom-1 left-3 size-1.5 rounded-full bg-[#2e6db4]" />
            <span className="absolute -right-2 bottom-3 size-2 rounded-full bg-[#e8a020]" />
          </span>
          <p className="mt-5 text-[18px] font-bold text-ink">
            {isFood ? "Order cancelled" : "Booking cancelled"}
          </p>
          <p className="mt-1 text-[13px] text-cocoa">
            {isFood
              ? "Your order has been cancelled successfully."
              : "Your booking has been cancelled successfully."}
          </p>
          <p className="mt-4 flex items-center gap-2 rounded-card border border-line bg-beige/30 px-3.5 py-2.5 text-[12px] text-cocoa">
            <ShieldCheck size={14} className="shrink-0 text-success" />
            Refund (if applicable) will be processed within 3–5 business hours.
          </p>
          <Link
            href="/history"
            className="mt-6 w-full rounded-pill bg-success py-3 text-center text-[14px] font-semibold text-white transition-colors hover:bg-[#15803d]"
          >
            Done
          </Link>
        </Card>
      </FadeIn>
    );
  }

  return (
    <FadeIn y={10}>
      {/* "Help us improve" cancel sheet (Figma bottom sheet) */}
      {cancelSheet && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 lg:items-center"
          onClick={() => !cancelling && setCancelSheet(false)}
        >
          <div
            role="dialog"
            aria-label="Help us improve"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-3xl bg-white p-6 shadow-card lg:rounded-3xl"
          >
            <span className="mx-auto block h-1 w-10 rounded-full bg-line" />
            <p className="mt-4 text-center text-[17px] font-bold text-ink">
              Help us improve
            </p>
            <p className="mt-0.5 text-center text-[13px] text-cocoa">
              Why are you cancelling this {isFood ? "order" : "booking"}?
            </p>
            <div className="mt-4 flex flex-col divide-y divide-line/70">
              {CANCEL_REASONS.map((r) => (
                <label key={r} className="flex cursor-pointer items-center gap-3 py-3">
                  <span
                    className={
                      cancelReason === r
                        ? "flex size-5 items-center justify-center rounded-full border-[6px] border-accent"
                        : "size-5 rounded-full border-2 border-line"
                    }
                  />
                  <input
                    type="radio"
                    name="cancel-reason"
                    className="sr-only"
                    checked={cancelReason === r}
                    onChange={() => setCancelReason(r)}
                  />
                  <span className="text-[14px] text-ink">{r}</span>
                </label>
              ))}
            </div>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setCancelSheet(false)}
                disabled={cancelling}
                className="flex-1 rounded-pill border border-line bg-card py-3 text-[13px] font-semibold text-ink"
              >
                {L.keepCta}
              </button>
              <button
                onClick={() => cancelOrder(cancelReason ?? undefined)}
                disabled={cancelling}
                className="flex-1 rounded-pill bg-danger py-3 text-[13px] font-semibold text-white transition-colors hover:bg-[#c0392b] disabled:opacity-60"
              >
                {cancelling ? L.cancellingCta : L.confirmCancelCta}
              </button>
            </div>
          </div>
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
              <p className="text-[13px] font-bold text-success">Your ride is confirmed</p>
              <p className="text-[11.5px] text-cocoa">
                Track it live here — we&apos;ll notify you at every step.
              </p>
            </div>
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
            {canCancel && (
              <button
                onClick={() => setCancelSheet(true)}
                disabled={cancelling}
                className="mt-3 w-full rounded-pill border border-danger/40 bg-card py-2.5 text-[12px] font-semibold text-danger transition-colors hover:bg-danger/5 disabled:opacity-60"
              >
                {cancelling ? L.cancellingCta : L.cancelCta}
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
                    aria-label="Call"
                    className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-white transition-transform hover:scale-105"
                  >
                    <Phone size={17} />
                  </a>
                  <a
                    href="sms:"
                    onClick={(e) => e.preventDefault()}
                    title={t.driver.phoneMasked}
                    aria-label="Message"
                    className="flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-card text-ink transition-transform hover:scale-105"
                  >
                    <MessageCircle size={17} />
                  </a>
                </div>
              )}
              {isFood && !done && (
                <p className="mt-1.5 text-[10.5px] text-muted">
                  {tr("track.food.otpHint")}
                </p>
              )}

              {cancelError && (
                <p className="mt-2 rounded-card bg-danger/5 px-3 py-2 text-[12px] font-medium text-danger">
                  {cancelError}
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
                {canCancel && (
                  <button
                    onClick={() => setCancelSheet(true)}
                    disabled={cancelling}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-pill border border-danger/40 bg-card py-2.5 text-[12px] font-semibold text-danger transition-colors hover:bg-danger/5 disabled:opacity-60"
                  >
                    <X size={14} /> {cancelling ? L.cancellingCta : L.cancelCta}
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
