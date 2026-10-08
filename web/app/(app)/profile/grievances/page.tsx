"use client";

import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Clock, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { SubPage } from "@/components/profile/SubPage";
import { cn } from "@/lib/cn";

// Grievances, from the account rather than from an order.
//
// The cases themselves are the complaint screens that already exist: Need Help
// raises one against an order, and /complaints/[id] is the tracker with its
// timeline, resolution and refund. What was missing was a way in that did not
// start by remembering which order it was about. Somebody chasing a case a
// fortnight later is not thinking "which order was that", they are thinking
// "where is my complaint", and the only route in was through the order.
//
// So this lists them and hands off. It deliberately owns no case detail of its
// own, because a second screen showing the same case differently is how two
// versions of the truth start.

type Complaint = {
  id: string;
  code: string;
  status: string;
  category: string;
  subCategory: string | null;
  orderId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  assignBy: string | null;
  contactBy: string | null;
  investigateBy: string | null;
  assignedAt: string | null;
  contactedAt: string | null;
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

// Whether a published deadline has gone by unmet. Worked out on read: a stored
// flag would be wrong within the hour.
function overdue(due: string | null, met: string | null): boolean {
  return Boolean(due && !met && new Date(due).getTime() < Date.now());
}

// The complaint's own vocabulary is ONDC's: ITEM_DAMAGED, WRONG_ITEM_DELIVERED.
// Correct on the wire and unreadable on a screen, so it is turned back into a
// sentence rather than shouted at the customer in upper snake case. Anything
// unmapped is de-cased rather than shown raw, so a new ONDC code degrades to
// "Item not received" rather than to noise.
const ISSUE_COPY: Record<string, TranslationKey> = {
  ITEM_DAMAGED: "cx.itemDamaged",
  WRONG_ITEM_DELIVERED: "cx.wrongItem",
  ITEM_NOT_RECEIVED: "gv.itemNotReceived",
  ITEM_MISSING: "gv.itemMissing",
  REFUND_NOT_RECEIVED: "cx.refundNotReceived",
  PAYMENT_ISSUE: "cx.paymentIssue",
  DELAYED_DELIVERY: "gv.delayed",
  QUALITY_ISSUE: "gv.quality",
  ORDER_NOT_RECEIVED: "cx.orderNotReceived",
  // Ride complaints, which read nothing like the delivery ones.
  DRIVER_NOT_ARRIVED: "cx.driverNotArrived",
  RIDE_NOT_COMPLETED: "cx.rideNotCompleted",
  FARE_DISPUTE: "cx.fareDispute",
  DRIVER_CONDUCT: "cx.driverConduct",
  VEHICLE_ISSUE: "cx.vehicleIssue",
  FULFILLMENT: "gv.fulfillment",
  ITEM: "gv.item",
  PAYMENT: "cx.paymentIssue",
  OTHER: "cx.other",
};

function issueLabel(code: string, t: (key: TranslationKey) => string): string {
  const known = ISSUE_COPY[code];
  if (known) return t(known);
  const words = code.replace(/_/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const STATUS_COPY: Record<string, TranslationKey> = {
  OPEN: "gv.submitted",
  PROCESSING: "cx.investigating",
  RESOLVED: "cx.resolved",
  CLOSED: "cx.closed",
  ESCALATED: "gv.escalated",
};

export default function GrievancesPage() {
  const { t } = useI18n();
  const [list, setList] = useState<Complaint[] | null>(null);

  const load = useCallback(() => {
    api<{ complaints: Complaint[] }>("/api/complaints")
      .then((r) => setList(r.complaints))
      .catch(() => setList([]));
  }, []);
  useEffect(load, [load]);

  return (
    <SubPage title={t("gv.title")}>
      <p className="text-[13px] leading-relaxed text-acct-muted">
        {t("gv.intro")}
      </p>

      {list === null ? (
        <p className="mt-6 text-[13px] text-acct-muted">{t("dp.loading")}</p>
      ) : list.length === 0 ? (
        <div className="mt-8 flex flex-col items-center px-6 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-acct-tint">
            <ShieldAlert size={24} className="text-acct-accent" />
          </span>
          <p className="mt-4 text-[16px] font-bold text-acct-ink">
            {t("gv.none")}
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-acct-muted">
            {t("gv.howTo")}
          </p>
          {/* /history, not /orders: the orders list lives under Booking
              History and /orders is not a route. This was a dead link. */}
          <Link
            href="/history"
            className="tap-target mt-5 rounded-pill bg-acct-accent px-5 py-3 text-[14px] font-bold text-white"
          >
            {t("gv.goOrders")}
          </Link>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {list.map((c) => {
            const late =
              overdue(c.assignBy, c.assignedAt) ||
              overdue(c.contactBy, c.contactedAt) ||
              overdue(c.investigateBy, c.resolvedAt);
            const nextDue = !c.assignedAt
              ? { label: t("gv.assignBy"), when: c.assignBy, met: c.assignedAt }
              : !c.contactedAt
                ? { label: t("gv.contactBy"), when: c.contactBy, met: c.contactedAt }
                : { label: t("gv.investigateBy"), when: c.investigateBy, met: c.resolvedAt };

            return (
              <Link
                key={c.id}
                href={`/complaints/${c.id}`}
                className="flex items-center gap-3 rounded-2xl border border-acct-line bg-acct-card p-4 transition-colors hover:bg-acct-bg"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[13px] font-bold text-acct-ink">
                      {c.code}
                    </span>
                    <span className="text-[12px] text-acct-muted">
                      {STATUS_COPY[c.status] ? t(STATUS_COPY[c.status]!) : c.status}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-[14px] text-acct-ink">
                    {issueLabel(c.subCategory ?? c.category, t)}
                  </span>
                  {c.resolvedAt ? (
                    <span className="mt-1 block text-[12px] text-acct-muted">
                      {t("gv.resolved")}{" "}{day(c.resolvedAt)}
                    </span>
                  ) : (
                    // Cases raised before the deadlines were introduced carry
                    // none. Back-filling one from createdAt would announce a
                    // commitment that was never actually made at the time.
                    nextDue.when && (
                      <span className="mt-1 flex items-center gap-1.5 text-[12px]">
                        <Clock
                          size={11}
                          className={late ? "text-danger" : "text-acct-muted"}
                        />
                        <span className="text-acct-muted">{nextDue.label}</span>
                        <span
                          className={cn(
                            "font-medium",
                            overdue(nextDue.when, nextDue.met)
                              ? "text-danger"
                              : "text-acct-ink",
                          )}
                        >
                          {day(nextDue.when)}
                          {/* Said plainly when we have missed our own
                              deadline. Hiding it does not make it untrue and
                              the person waiting already knows. */}
                          {overdue(nextDue.when, nextDue.met) ? t("gv.overdue") : ""}
                        </span>
                      </span>
                    )
                  )}
                </span>
                <ChevronRight size={17} className="shrink-0 text-acct-muted" />
              </Link>
            );
          })}
        </div>
      )}
    </SubPage>
  );
}
