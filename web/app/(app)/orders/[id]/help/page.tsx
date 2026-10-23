"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useBackTo } from "@/lib/navHistory";
import {
  ArrowLeft,
  Package,
  ArrowLeftRight,
  PackageOpen,
  RotateCcw,
  CreditCard,
  Ellipsis,
  Mail,
  Clock,
  Image as ImageIcon,
  Info,
  SendHorizonal,
  MapPin,
  CarFront,
  MapPinOff,
  IndianRupee,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/cn";
import { useI18n } from "@/components/i18n/I18nContext";

// ONDC IGM 2.0 — raising a complaint, restyled to the Component-page Figma:
// centred titles, warm outlined buttons, leading problem icons with the radio
// on the right, a 500-character description, and a centred photo drop box.
//
// The categories below are UI labels with our own internal codes. They are NOT
// ONDC enum values — the guide is explicit that those must come from the live
// spec, and inventing them would produce complaints the network rejects. The
// adapter maps these to the real vocabulary once we have it.
type Problem = {
  code: string;
  labelKey: TranslationKey;
  icon: typeof Package;
};

// Money and refunds go wrong the same way whichever thing was bought.
const SHARED = [
  { code: "REFUND_NOT_RECEIVED", labelKey: "cx.refundNotReceived", icon: RotateCcw },
  { code: "PAYMENT_ISSUE", labelKey: "cx.paymentIssue", icon: CreditCard },
  { code: "OTHER", labelKey: "cx.other", icon: Ellipsis },
] as const satisfies ReadonlyArray<Problem>;

const FOOD_PROBLEMS = [
  { code: "ORDER_NOT_RECEIVED", labelKey: "cx.orderNotReceived", icon: Package },
  { code: "WRONG_ITEM_DELIVERED", labelKey: "cx.wrongItem", icon: ArrowLeftRight },
  { code: "ITEM_DAMAGED", labelKey: "cx.itemDamaged", icon: PackageOpen },
  ...SHARED,
] as const satisfies ReadonlyArray<Problem>;

// A rider has no item to be damaged and nothing was delivered to them. Offering
// "wrong item delivered" after a trip is the product admitting it does not know
// what the person just bought, and it puts a complaint into a category no
// operator can action.
const RIDE_PROBLEMS = [
  { code: "DRIVER_NOT_ARRIVED", labelKey: "cx.driverNotArrived", icon: CarFront },
  { code: "RIDE_NOT_COMPLETED", labelKey: "cx.rideNotCompleted", icon: MapPinOff },
  { code: "FARE_DISPUTE", labelKey: "cx.fareDispute", icon: IndianRupee },
  { code: "DRIVER_CONDUCT", labelKey: "cx.driverConduct", icon: ShieldAlert },
  { code: "VEHICLE_ISSUE", labelKey: "cx.vehicleIssue", icon: TriangleAlert },
  ...SHARED,
] as const satisfies ReadonlyArray<Problem>;

type Step = "problem" | "details" | "submitted";
type OrderCard = {
  title: string;
  itemCount: number | null;
  createdAt: string;
  domain: string;
};

export default function OrderHelpPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const { t } = useI18n();
  // Same fault as the support chat: pushing the order screen as "back" grew
  // the stack instead of unwinding it.
  const leaveFlow = useBackTo(`/orders/${params.id}`);

  const [step, setStep] = useState<Step>("problem");
  const [order, setOrder] = useState<OrderCard | null>(null);
  const [problem, setProblem] = useState<string>("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState("");
  const [photoFailed, setPhotoFailed] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [complaintId, setComplaintId] = useState<string | null>(null);

  // Ride until the order says otherwise. Defaulting to the food list would
  // quietly offer a rider "item damaged" for the moment before the order
  // loads, which is the exact bug this splits apart.
  const problems: readonly Problem[] =
    order?.domain === "ride" ? RIDE_PROBLEMS : FOOD_PROBLEMS;
  const chosen = problems.find((p) => p.code === problem);

  // The order summary card at the top of the problem step.
  useEffect(() => {
    let cancelled = false;
    api<{
      order: {
        title: string;
        createdAt: string;
        domain: string;
        details: { items?: unknown[] };
      };
    }>(
      `/api/orders/${orderId}`,
    )
      .then((d) => {
        if (cancelled) return;
        setOrder({
          title: d.order.title,
          itemCount: Array.isArray(d.order.details.items)
            ? d.order.details.items.length
            : null,
          createdAt: d.order.createdAt,
          domain: d.order.domain,
        });
      })
      // Not an app order: it may be a food order or ride placed through
      // ONDC, which lives apart. Its kind decides food or ride problems.
      .catch(() =>
        api<{ kind: "food" | "ride"; title: string; createdAt: string; itemCount: number | null }>(`/api/ondc/mine/${orderId}`).then((d) => {
          if (cancelled) return;
          setOrder({ title: d.title, itemCount: d.itemCount, createdAt: d.createdAt, domain: d.kind });
        }),
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  function pickPhoto(file: File | undefined) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError(t("cx.fileTooBig"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPhoto(typeof reader.result === "string" ? reader.result : null);
      setPhotoName(file.name);
      setError("");
    };
    reader.readAsDataURL(file);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const d = await api<{ complaint: { id: string; code: string } }>(
        "/api/complaints",
        {
          method: "POST",
          json: {
            orderId,
            category: "ORDER",
            subCategory: problem,
            description: description.trim(),
          },
        },
      );

      // Evidence needs the complaint to exist, so it follows rather than being
      // sent with it. A failed photo must not lose the complaint the customer
      // just wrote.
      if (photo) {
        await api(`/api/complaints/${d.complaint.id}/evidence`, {
          method: "POST",
          json: { dataUrl: photo },
        }).catch(() => setPhotoFailed(true));
      }

      setCode(d.complaint.code);
      setComplaintId(d.complaint.id);
      setStep("submitted");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cx.submitFailed"));
    } finally {
      setBusy(false);
    }
  }

  function back() {
    // Within the form, back walks the steps; at the first step it leaves.
    if (step === "details") setStep("problem");
    else leaveFlow();
  }

  return (
    <div className="min-h-dvh bg-cream">
      <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 pb-8 lg:max-w-[680px] lg:px-6">
        <div className="flex items-center py-4">
          <button
            onClick={back}
            aria-label={t("common.back")}
            className="tap-target flex size-9 items-center justify-center rounded-full bg-card shadow-soft transition-colors hover:bg-beige/60"
          >
            <ArrowLeft size={18} className="text-ink" />
          </button>
          <h1 className="flex-1 pr-9 text-center text-[17px] font-extrabold text-ink">
            {step === "problem" ? t("cx.needHelp") : t("cx.addDetails")}
          </h1>
        </div>

        {step === "problem" && (
          <>
            <div className="rounded-[16px] bg-card p-4 shadow-soft">
              <p className="text-[15px] font-bold text-ink">
                {/* "Order #" over a trip is the same mix-up as offering a
                    rider a damaged item. */}
                {order?.domain === "ride" ? t("cx.ride") : t("cx.order")} #
                {orderId.slice(0, 8).toUpperCase()}
              </p>
              {order && (
                <>
                  <p className="mt-0.5 text-[13px] text-cocoa">
                    {order.title}
                    {order.itemCount != null && `, ${order.itemCount} item${order.itemCount === 1 ? "" : "s"}`}
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted">
                    {new Date(order.createdAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}{" "}
                    •{" "}
                    {new Date(order.createdAt).toLocaleTimeString("en-IN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </>
              )}
            </div>

            <p className="mb-2 mt-6 px-1 text-[16px] font-extrabold text-ink">
              {t("cx.whatProblem")}
            </p>
            <div
              className="flex flex-col gap-2"
              role="radiogroup"
              aria-label={t("cx.whatProblem")}
            >
              {problems.map((p) => {
                const active = problem === p.code;
                const Icon = p.icon;
                return (
                  <button
                    key={p.code}
                    role="radio"
                    aria-checked={active}
                    onClick={() => setProblem(p.code)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-[14px] bg-card px-4 py-3.5 text-left shadow-soft transition-all",
                      active
                        ? "ring-1 ring-accent"
                        : "hover:bg-beige/30",
                    )}
                  >
                    <Icon size={17} className="shrink-0 text-ink" />
                    <span className="flex-1 text-[14px] font-semibold text-ink">
                      {t(p.labelKey)}
                    </span>
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border-2",
                        active ? "border-accent" : "border-line",
                      )}
                    >
                      {active && <span className="size-2.5 rounded-full bg-accent" />}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex-1" />
            <button
              disabled={!problem}
              onClick={() => setStep("details")}
              className="mt-7 h-[54px] w-full rounded-[14px] border-[1.5px] border-acct-accent bg-card text-[15px] font-bold text-ink transition-colors hover:bg-accent-soft/40 disabled:opacity-40"
            >
              {t("cx.continue")}
            </button>
          </>
        )}

        {step === "details" && (
          <>
            <div className="inline-flex items-center gap-2 self-start rounded-pill border border-line bg-card px-3.5 py-2 shadow-soft">
              {chosen && <chosen.icon size={14} className="text-ink" />}
              <span className="text-[13px] font-semibold text-ink">
                {t("cx.issue")}: {chosen ? t(chosen.labelKey) : ""}
              </span>
            </div>

            <label className="mt-5 block">
              <span className="text-[14px] font-bold text-ink">
                {t("cx.describe")}
              </span>
              <span className="relative mt-2 block">
                <textarea
                  autoFocus
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 500))}
                  rows={6}
                  placeholder={t("cx.describePh")}
                  className="w-full resize-none rounded-[14px] border border-line bg-card p-4 pb-7 text-[14px] text-ink shadow-soft outline-none placeholder:text-muted focus:border-accent"
                />
                <span className="absolute bottom-3 right-3.5 text-[11px] text-muted">
                  {description.trim().length}/500
                </span>
              </span>
            </label>

            <p className="mt-4 text-[14px] font-bold text-ink">{t("cx.addPhoto")}</p>
            <label className="mt-2 flex cursor-pointer flex-col items-center gap-1.5 rounded-[14px] border border-line bg-card px-4 py-7 shadow-soft transition-colors hover:bg-beige/30">
              <ImageIcon size={22} className="text-ink" />
              <span className="text-[14px] font-bold text-ink">
                {photoName || t("cx.addPhotoBtn")}
              </span>
              <span className="text-[11px] text-muted">{t("cx.photoTypes")}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => pickPhoto(e.target.files?.[0])}
              />
            </label>
            <p className="mt-3 flex items-center gap-2 rounded-[12px] border border-line bg-card px-3.5 py-2.5 text-[12px] font-medium text-cocoa">
              <Info size={13} className="shrink-0" />
              {t("cx.photoHint")}
            </p>

            {error && (
              <p role="alert" className="mt-3 text-[14px] text-danger">
                {error}
              </p>
            )}

            <div className="flex-1" />
            <button
              disabled={busy || description.trim().length < 5}
              onClick={submit}
              className="mt-6 flex h-[54px] w-full items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-acct-accent bg-card text-[15px] font-bold text-ink transition-colors hover:bg-accent-soft/40 disabled:opacity-40"
            >
              <SendHorizonal size={16} />
              {busy ? t("cx.submitting") : t("cx.submit")}
            </button>
          </>
        )}

        {step === "submitted" && (
          <div className="flex flex-1 flex-col">
            <div className="flex flex-1 flex-col justify-center text-center">
              <h2 className="text-[24px] font-extrabold text-ink">
                {t("cx.submitted")}
              </h2>
              <p className="mt-2 text-[14px] font-bold text-ink">
                {t("cx.complaintId")}: {code}
              </p>
              <p className="mt-1 text-[13px] text-muted">
                {t("cx.updateIn24")}
              </p>
              {photoFailed && (
                <p className="mx-auto mt-3 max-w-[320px] text-[13px] text-warning">
                  {t("cx.photoFailed")}
                </p>
              )}

              <div className="mt-7 flex flex-col gap-2.5">
                <div className="flex items-center gap-3 rounded-[14px] bg-card px-4 py-3.5 text-left shadow-soft">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft">
                    <Mail size={16} className="text-accent" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-bold text-ink">
                      {t("cx.emailConfirm")}
                    </span>
                    <span className="block text-[12px] text-muted">
                      {t("cx.sentToEmail")}
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-3 rounded-[14px] bg-card px-4 py-3.5 text-left shadow-soft">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft">
                    <Clock size={16} className="text-accent" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-bold text-ink">
                      {t("cx.resolutionTime")}
                    </span>
                    <span className="block text-[12px] text-muted">
                      {t("cx.within2448")}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <Link
              href={`/complaints/${complaintId}`}
              className="mt-7 flex h-[54px] w-full items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-acct-accent bg-card text-[15px] font-bold text-ink transition-colors hover:bg-accent-soft/40"
            >
              <MapPin size={16} />
              {t("cx.trackComplaint")}
            </Link>
            <Link
              href="/history"
              className="mt-4 text-center text-[14px] font-bold text-ink hover:underline"
            >
              {t("cx.backToOrders")}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
