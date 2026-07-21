"use client";

import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Circle, Receipt, ChevronLeft, LifeBuoy } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { DecisionReceipt } from "@/components/orders/DecisionReceipt";
import { RideTracker } from "@/components/orders/RideTracker";
import { LoadingView, ErrorView } from "@/components/ui/StatusView";
import { cn } from "@/lib/cn";
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
  const { t } = useI18n();

  useEffect(() => {
    const load = () =>
      api<{ order: OrderDetail }>(`/api/orders/${id}`)
        .then((d) => {
          setOrder(d.order);
          setError("");
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
    load();
    const fetchTimer = setInterval(load, POLL_MS);
    // A faster local clock advances the driver marker smoothly between fetches.
    const tickTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(fetchTimer);
      clearInterval(tickTimer);
    };
  }, [id]);

  if (!order) {
    return error ? (
      <ErrorView
        notFound
        title={t("order.notFound")}
        message="We couldn't find this order — it may have been removed."
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

  const discount =
    order.details.offers?.reduce((s, o) => s + o.discountPaise, 0) ?? 0;

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 lg:px-6">
      <Link
        href="/history"
        className="flex items-center gap-1 text-[13px] font-medium text-cocoa hover:text-ink"
      >
        <ChevronLeft size={16} /> {t("nav.history")}
      </Link>

      <h1 className="mt-3 text-[19px] font-bold text-ink">{order.title}</h1>
      <p className="mt-0.5 text-[12px] text-cocoa">
        {new Date(order.createdAt).toLocaleString("en-IN")}
      </p>

      {/* Live tracking — driver / delivery partner, OTP, moving map (free) */}
      {hasTrackingCoords && (
        <div className="mt-5">
          <RideTracker
            orderId={order.id}
            domain={order.domain}
            pickup={{ lat: d.pickupLat!, lng: d.pickupLng! }}
            drop={{ lat: d.dropLat!, lng: d.dropLng! }}
            dropLabel={order.domain === "food" ? "your address" : d.drop ?? "your drop"}
          />
        </div>
      )}

      {/* Tracking timeline */}
      {order.trackingEvents.length > 0 && (
        <Card className="mt-5">
          <h2 className="text-[14px] font-bold text-ink">
            {allDone
              ? order.domain === "food"
                ? t("order.delivered")
                : t("order.tripCompleted")
              : order.domain === "food"
                ? t("order.trackingOrder")
                : t("order.trackingRide")}
          </h2>
          <div className="mt-3 flex flex-col">
            {order.trackingEvents.map((e, i) => {
              const isReached = new Date(e.createdAt).getTime() <= now;
              const isLast = i === order.trackingEvents.length - 1;
              return (
                <div key={e.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    {isReached ? (
                      <CheckCircle2 size={18} className="shrink-0 text-success" />
                    ) : (
                      <Circle size={18} className="shrink-0 text-line" />
                    )}
                    {!isLast && (
                      <span
                        className={cn(
                          "w-px flex-1",
                          isReached ? "bg-success/50" : "bg-line",
                        )}
                      />
                    )}
                  </div>
                  <div className={cn("pb-5", !isReached && "opacity-50")}>
                    <p className="text-[13px] font-semibold text-ink">{e.message}</p>
                    <p className="text-[11px] text-cocoa">
                      {new Date(e.createdAt).toLocaleTimeString("en-IN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

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
                ? `${order.payment.method?.toUpperCase() ?? "—"} · ${order.payment.status}`
                : "—"
            }
          />
          <Row label={t("bill.orderId")} value={order.id} mono />
        </div>
      </Card>

      {/* Something wrong? Straight into the support flow with this order linked. */}
      <Link
        href={`/profile/help?order=${order.id}`}
        className="mt-4 flex items-center justify-center gap-2 rounded-pill border border-line bg-card py-3 text-[13px] font-semibold text-cocoa transition-colors hover:bg-beige/40"
      >
        <LifeBuoy size={15} className="text-accent" /> {t("order.reportIssue")}
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
      <span className="text-cocoa">{label}</span>
      <span
        className={cn(
          "text-right text-ink",
          bold && "text-[15px] font-bold",
          accent && "font-medium text-success",
          mono && "break-all font-mono text-[11px] text-cocoa",
        )}
      >
        {value}
      </span>
    </div>
  );
}
