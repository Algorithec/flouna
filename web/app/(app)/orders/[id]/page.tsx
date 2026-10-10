"use client";

import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Receipt, ChevronLeft, LifeBuoy } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { RateOrder } from "@/components/orders/RateOrder";
import { CancelOrderSheet } from "@/components/orders/CancelOrderSheet";
import { TrackingTimeline } from "@/components/orders/TrackingTimeline";
import { DecisionReceipt } from "@/components/orders/DecisionReceipt";
import { RideTracker } from "@/components/orders/RideTracker";
import { LoadingView, ErrorView } from "@/components/ui/StatusView";
import { cn } from "@/lib/cn";
import { useBackTo } from "@/lib/navHistory";
import { useI18n } from "@/components/i18n/I18nContext";

type TrackingEvent = {
  id: string;
  status: string;
  message: string;
  createdAt: string;
};

type OrderDetail = {
  id: string;
  domain: "food" | "ride";
  status: string;
  provider: string;
  title: string;
  amount: number;
  savedPaise: number;
  createdAt: string;
  details: {
    basePaise?: number;
    deliveryFeePaise?: number;
    convenienceFeePaise?: number;
    offers?: { label: string; discountPaise: number }[];
    farePaise?: number;
    pickup?: string;
    drop?: string;
    pickupLat?: number;
    pickupLng?: number;
    dropLat?: number;
    dropLng?: number;
    comparedOptions?: number;
    comparedPlatforms?: number;
    items?: { name: string; qty: number; pricePaise: number }[];
    instructions?: string;
  };
  trackingEvents: TrackingEvent[];
  payment: { status: string; method: string | null } | null;
  rating?: { stars: number } | null;
};

const POLL_MS = 15_000;

export default function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const search = useSearchParams();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  // Reported up by RideTracker so the cancel dialog can show "Driver is only
  // N min away" without a second /track poll of its own.
  const [tracking, setTracking] = useState<{ driverName: string | null; etaMinutes: number | null }>({
    driverName: null,
    etaMinutes: null,
  });
  const { t } = useI18n();
  // History is where this screen lives, but it is rarely where the customer
  // came from: after paying they arrive from checkout, and pushing History on
  // top of that made the back control add an entry instead of removing one.
  const back = useBackTo("/history");

  // A finished order cannot change again, so neither timer below is started
  // once it has. Opening last month's delivered order used to poll it every 15
  // seconds and tick a clock every second for as long as the tab stayed open —
  // on a phone, on mobile data, for nothing.
  const settled = order?.status === "completed" || order?.status === "cancelled";

  useEffect(() => {
    let active = true;
    const load = () =>
      api<{ order: OrderDetail }>(`/api/orders/${id}`)
        .then((d) => {
          if (!active) return;
          setOrder(d.order);
          setError("");
        })
        .catch((e) => active && setError(e instanceof Error ? e.message : t("od.loadFailed")));
    load();
    if (settled) {
      return () => {
        active = false;
      };
    }
    const fetchTimer = setInterval(load, POLL_MS);
    // A faster local clock advances the driver marker smoothly between fetches.
    const tickTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      clearInterval(fetchTimer);
      clearInterval(tickTimer);
    };
    // t only words the error; a change of language restarts polling once.
  }, [id, t, settled]);

  if (!order) {
    return error ? (
      <ErrorView
        notFound
        title={t("order.notFound")}
        message={t("od.notFoundMsg")}
        backHref="/history"
        backLabel={t("order.backToHistory")}
      />
    ) : (
      <LoadingView rows={4} />
    );
  }

  // Events are seeded with future timestamps — only "reached" ones count.
  const reached = order.trackingEvents.filter(
    (e) => new Date(e.createdAt).getTime() <= now,
  );
  const allDone =
    order.status === "completed" ||
    (order.trackingEvents.length > 0 && reached.length === order.trackingEvents.length);
  const showInvoice = search.get("invoice") === "1";

  // Live tracking — driver/delivery-partner, OTP and a moving map, served by
  // the fulfilment provider. Shown for rides AND food deliveries with coords.
  const d = order.details;
  const hasTrackingCoords =
    d.pickupLat != null &&
    d.pickupLng != null &&
    d.dropLat != null &&
    d.dropLng != null;
  // An order still awaiting payment has no fulfilment to track, and /track
  // answers 409 for exactly that case. Mounting the tracker anyway left it
  // polling a route that could never succeed, once every few seconds, for as
  // long as the page stayed open.
  const trackable = hasTrackingCoords && order.status !== "pending_payment";

  const discount =
    order.details.offers?.reduce((s, o) => s + o.discountPaise, 0) ?? 0;

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 lg:px-6">
      <button
        type="button"
        onClick={back}
        className="tap-target flex items-center gap-1 text-[13px] font-medium text-cocoa hover:text-ink"
      >
        <ChevronLeft size={16} /> {t("nav.history")}
      </button>

      <h1 className="mt-3 text-[19px] font-bold text-ink">{order.title}</h1>
      <p className="mt-0.5 text-[12px] text-cocoa">
        {new Date(order.createdAt).toLocaleString("en-IN")}
      </p>

      {/* Live tracking — driver / delivery partner, OTP, moving map (free) */}
      {trackable && (
        <div className="mt-5">
          <RideTracker
            orderId={order.id}
            domain={order.domain}
            pickup={{ lat: d.pickupLat!, lng: d.pickupLng! }}
            drop={{ lat: d.dropLat!, lng: d.dropLng! }}
            pickupLabel={d.pickup ?? t("od.yourPickup")}
            dropLabel={order.domain === "food" ? t("od.yourAddress") : d.drop ?? t("od.yourDrop")}
            farePaise={d.farePaise ?? order.amount}
            onCancelRequest={() => setCancelling(true)}
            onTrackingUpdate={setTracking}
          />
        </div>
      )}

      {/* Rate the order — only once it's actually done */}
      {allDone && order.status !== "cancelled" && (
        <RateOrder
          orderId={order.id}
          domain={order.domain}
          existingStars={order.rating?.stars ?? null}
        />
      )}

      {/* Tracking timeline — live ETA, active step and progress */}
      <TrackingTimeline
        events={order.trackingEvents}
        domain={order.domain}
        now={now}
        title={
          allDone
            ? order.domain === "food"
              ? t("order.delivered")
              : t("order.tripCompleted")
            : order.domain === "food"
              ? t("order.trackingOrder")
              : t("order.trackingRide")
        }
      />

      {order.details.comparedOptions !== undefined && (
        <div className="mt-4">
          <DecisionReceipt
            comparedOptions={order.details.comparedOptions}
            comparedPlatforms={order.details.comparedPlatforms ?? 1}
            savedPaise={order.savedPaise}
            domain={order.domain}
            title={order.title}
          />
        </div>
      )}

      {/* Invoice */}
      <Card className={cn("mt-4", showInvoice && "border-accent/60 ring-1 ring-accent/30")}>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
            <Receipt size={15} className="text-cocoa" /> {t("order.invoice")}
          </h2>
          <Link
            href={`/orders/${order.id}/invoice`}
            className="text-[12px] font-semibold text-accent hover:underline"
          >
            {t("order.viewDownload")}
          </Link>
        </div>
        <div className="mt-3 flex flex-col gap-1.5 text-[13px]">
          {order.domain === "food" ? (
            <>
              {order.details.items?.map((i, idx) => (
                <Row
                  key={idx}
                  label={`${i.name} × ${i.qty}`}
                  value={rupees(i.pricePaise * i.qty)}
                />
              ))}
              <Row label={t("bill.itemTotal")} value={rupees(order.details.basePaise ?? order.amount)} />
              {order.details.deliveryFeePaise !== undefined && (
                <Row label={t("bill.deliveryFee")} value={rupees(order.details.deliveryFeePaise)} />
              )}
              {order.details.convenienceFeePaise !== undefined &&
                (order.details.convenienceFeePaise > 0 ? (
                  <Row
                    label={t("bill.convenienceFee")}
                    value={rupees(order.details.convenienceFeePaise)}
                  />
                ) : (
                  <Row label={t("bill.convenienceFeePlus")} value={t("bill.waived")} accent />
                ))}
            </>
          ) : (
            <>
              {order.details.pickup && (
                <Row label={t("bill.pickup")} value={order.details.pickup} />
              )}
              {order.details.drop && <Row label={t("bill.drop")} value={order.details.drop} />}
              <Row label={t("bill.baseFare")} value={rupees(order.details.farePaise ?? order.amount)} />
            </>
          )}
          {discount > 0 && <Row label={t("bill.offers")} value={`− ${rupees(discount)}`} accent />}
          <div className="my-1.5 h-px bg-line" />
          <Row label={t("bill.totalPaid")} value={rupees(order.amount)} bold />
          {order.savedPaise > 0 && (
            <Row
              label={t("bill.savedVsNext")}
              value={rupees(order.savedPaise)}
              accent
            />
          )}
          <Row
            label={t("bill.payment")}
            value={
              order.payment
                ? `${order.payment.method?.toUpperCase() ?? " "} · ${order.payment.status}`
                : t("od.notRecorded")
            }
          />
          <Row label={t("bill.orderId")} value={order.id} mono />
        </div>
      </Card>

      {/* Cancel — only while the order is still cancellable, and only here
          when RideTracker isn't already showing its own contextual cancel
          button (live tracking has one built into the driver card; before
          that, or for orders with no trackable coords, this is the only
          entry point). The server owns the real policy (food can't be
          cancelled once out for delivery), so this hides the obvious cases
          and lets the server refuse the rest with its own message rather
          than duplicating the rules here. */}
      {!trackable &&
        order.status !== "cancelled" &&
        order.status !== "completed" &&
        !allDone && (
          <button
            onClick={() => setCancelling(true)}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-pill border border-danger/30 bg-card py-3 text-[14px] font-semibold text-danger transition-colors hover:bg-danger/5"
          >
            {order.domain === "ride" ? t("od.cancelBooking") : t("track.food.cancelOrder")}
          </button>
        )}

      {cancelling && (
        <CancelOrderSheet
          orderId={order.id}
          domain={order.domain}
          driverName={tracking.driverName}
          etaMinutes={tracking.etaMinutes}
          onClose={() => setCancelling(false)}
          onCancelled={() =>
            setOrder((o) => (o ? { ...o, status: "cancelled" } : o))
          }
        />
      )}

      {/* Need Help opens the ONDC IGM complaint flow — a tracked grievance case
          with a complaint ID, not a helpdesk message. The older support link
          stays beneath it for questions that aren't a formal complaint. */}
      <Link
        href={`/orders/${order.id}/help`}
        className="mt-4 flex items-center justify-center gap-2 rounded-pill bg-ink py-3.5 text-[14px] font-bold text-white transition-opacity hover:opacity-90"
      >
        <LifeBuoy size={16} /> {t("od.needHelp")}
      </Link>
      <Link
        href={`/profile/help?order=${order.id}`}
        className="mt-3 flex items-center justify-center gap-2 rounded-pill border border-line bg-card py-3 text-[13px] font-semibold text-cocoa transition-colors hover:bg-beige/40"
      >
        {t("order.reportIssue")}
      </Link>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
  mono,
}: {
  label: string;
  value: string;
  bold?: boolean;
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-cocoa">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right text-ink",
          bold && "text-[15px] font-bold",
          accent && "font-medium text-success",
          // A raw order id wrapped with break-all + text-right staircases —
          // each wrapped line right-justifies on its own, reading as broken
          // rather than one value. Truncated to one line instead; the full
          // id is still in the URL and on the invoice page.
          mono && "truncate font-mono text-[11px] text-cocoa",
        )}
      >
        {value}
      </span>
    </div>
  );
}
