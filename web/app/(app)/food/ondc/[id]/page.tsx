"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Headset, Loader2, Store } from "lucide-react";
import { api } from "@/lib/api";
import { rupees } from "@/lib/money";
import { useBackTo } from "@/lib/navHistory";
import { useEscapeToClose } from "@/lib/useEscapeToClose";
import { loadCashfreeSdk } from "@/lib/payments/useCheckout";
import { Button } from "@/components/ui/Button";
import { ErrorView, LoadingView } from "@/components/ui/StatusView";
import { useI18n } from "@/components/i18n/I18nContext";
import type { TranslationKey } from "@/lib/i18n/dictionaries";

// One food order with an ONDC seller, from the price check to delivery.
//
// Every step is answered by the seller a few seconds later, so while the
// order is waiting on the seller this screen asks again every couple of
// seconds. What it offers next depends only on where the server says the
// order stands; nothing here decides that the order is paid or placed.

type QuoteLine = { type: string; title: string; count?: number; paise: number };
type OrderView = {
  id: string;
  status: string;
  store: string;
  problem: string | null;
  totalPaise: number | null;
  quote: { totalPaise: number; lines: QuoteLine[] } | null;
  sellerState: string | null;
  fulfillmentState: string | null;
  paid: boolean;
  tracking: { url: string; status?: string } | null;
  refund: { status: string; paise: number | null } | null;
};

/** Statuses where the seller still has to answer, so the screen keeps asking. */
const WAITING = new Set(["selecting", "initialising", "paid", "confirming", "cancelling"]);
/** A paid order that could not reach the store is not waiting: it needs the customer to place it again. */
const isWaiting = (o: OrderView) => WAITING.has(o.status) && !(o.status === "paid" && o.problem);
const POLL_MS = 2000;
const REASONS = ["006", "009", "010", "001", "003"] as const;
// Labels run long in Kannada, Tamil and Telugu, so these pills grow with
// their text instead of holding a fixed height it spills out of.
const PILL = "tap-target inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill px-4 py-2 text-center text-[14px] font-semibold leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const SOFT = `${PILL} bg-beige text-ink hover:bg-beige-hover`;

export default function OndcOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const search = useSearchParams();
  const { t } = useI18n();
  // Keys built from what the server or the seller sent. A seller may report a
  // delivery state with no wording here yet: its own word is shown, not a key.
  const tr = (key: string, fallback: string) => {
    const said = t(key as TranslationKey);
    return said === key ? fallback : said;
  };
  const goBack = useBackTo("/home");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [askCancel, setAskCancel] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("006");
  useEscapeToClose(askCancel && !busy, () => setAskCancel(false));
  const verified = useRef(false);

  const load = useCallback(async () => {
    try {
      setOrder(await api<OrderView>(`/api/ondc/orders/${id}`));
    } catch {
      setMissing(true);
    }
  }, [id]);

  // Back from the gateway: whether it was paid is asked of the gateway, once.
  useEffect(() => {
    if (verified.current) return;
    verified.current = true;
    const fromGateway = search.get("from") === "cashfree";
    (fromGateway ? api(`/api/ondc/orders/${id}/verify`, { method: "POST" }).catch(() => {}) : Promise.resolve()).finally(() => void load());
  }, [id, load, search]);

  useEffect(() => {
    if (!order || !isWaiting(order)) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [order, load]);

  async function step(path: string, json?: unknown) {
    setBusy(true);
    setActionFailed(false);
    try {
      await api(`/api/ondc/orders/${id}/${path}`, { method: "POST", ...(json ? { json } : {}) });
      await load();
      return true;
    } catch {
      setActionFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setBusy(true);
    setActionFailed(false);
    try {
      const r = await api<{ mode: "demo" | "cashfree"; paymentSessionId?: string; environment?: string }>(`/api/ondc/orders/${id}/pay`, { method: "POST" });
      if (r.mode === "cashfree" && r.paymentSessionId) {
        await loadCashfreeSdk();
        const cashfree = window.Cashfree?.({ mode: r.environment === "production" ? "production" : "sandbox" });
        if (!cashfree) throw new Error("gateway");
        // The gateway takes the tab and returns to this screen with ?from=cashfree.
        await cashfree.checkout({ paymentSessionId: r.paymentSessionId, redirectTarget: "_self" });
        return;
      }
      await load();
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (missing) return <ErrorView notFound title={t("oo.notFound")} />;
  if (!order) return <LoadingView rows={4} />;

  const waiting = isWaiting(order);
  const statusText = tr(`oo.s.${order.status}`, order.status);
  const lines = order.quote?.lines ?? [];

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
          <h1 className="flex-1 text-center text-[17px] font-extrabold text-acct-ink">{t("oo.title")}</h1>
          <span className="size-9" />
        </div>

        <section className="rounded-[18px] bg-card p-4 shadow-soft">
          <div className="flex items-center gap-2">
            <Store size={16} className="shrink-0 text-accent" />
            <p className="min-w-0 truncate text-[13px] text-acct-muted">{t("oo.soldBy").replace("{store}", order.store)}</p>
          </div>
          <div className="mt-2 flex items-center gap-2" role="status" aria-live="polite">
            {waiting && <Loader2 size={16} className="shrink-0 animate-spin text-accent" />}
            <p className="text-[17px] font-bold text-acct-ink">{statusText}</p>
          </div>
          {order.fulfillmentState && order.status !== "cancelled" && (
            <p className="mt-1 text-[13px] text-acct-muted">{tr(`oo.fs.${order.fulfillmentState}`, order.fulfillmentState)}</p>
          )}
          {order.problem && !waiting && <p className="mt-2 text-[13px] leading-relaxed text-danger">{order.problem}</p>}
          {order.refund && order.refund.paise !== 0 && (
            <p className="mt-2 text-[13px] font-semibold text-acct-ink">
              {tr(order.refund.status === "requested" ? "oo.refund.owed" : `oo.refund.${order.refund.status}`, "").replace("{amount}", rupees(order.refund.paise ?? 0))}
            </p>
          )}
          {waiting && <p className="mt-2 text-[12px] text-acct-muted">{t("oo.stepNote")}</p>}
        </section>

        {lines.length > 0 && (
          <section className="mt-3 rounded-[18px] bg-card p-4 shadow-soft">
            <h2 className="text-[13px] font-bold text-acct-ink">{t("oo.bill")}</h2>
            <ul className="mt-2 space-y-1.5">
              {lines.map((l, i) => (
                <li key={i} className="flex gap-3 text-[13px]">
                  <span className="min-w-0 flex-1 text-acct-ink">
                    {l.title}
                    {l.count && l.count > 1 ? ` × ${l.count}` : ""}
                  </span>
                  <span className="shrink-0 text-acct-ink">{rupees(l.paise)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-between border-t border-line pt-3 text-[15px] font-bold text-acct-ink">
              <span>{t("oo.total")}</span>
              <span>{rupees(order.totalPaise ?? order.quote!.totalPaise)}</span>
            </div>
          </section>
        )}

        <div className="mt-4 space-y-2">
          {order.status === "quoted" && (
            <Button className="w-full" disabled={busy} onClick={() => void step("init")}>
              {t("oo.continue")}
            </Button>
          )}
          {order.status === "ready_to_pay" && order.totalPaise != null && (
            <Button className="w-full" disabled={busy} onClick={() => void pay()}>
              {busy ? t("oo.opening") : t("oo.pay").replace("{amount}", rupees(order.totalPaise))}
            </Button>
          )}
          {/* Paid, but the seller could not be reached: placing it again is
              safe, because the server only accepts it while the order is paid
              and not already being placed. */}
          {order.status === "paid" && order.problem && (
            <Button className="w-full" disabled={busy} onClick={() => void step("confirm")}>
              {t("oo.placeAgain")}
            </Button>
          )}
          {order.status === "placed" && (
            <>
              <div className="flex gap-2">
                <button type="button" className={`${SOFT} flex-1`} disabled={busy} onClick={() => void step("status")}>
                  {t("oo.checkStatus")}
                </button>
                {order.tracking ? (
                  <a
                    href={order.tracking.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${SOFT} flex-1`}
                  >
                    {t("oo.openTracking")} <ExternalLink size={14} />
                  </a>
                ) : (
                  <button type="button" className={`${SOFT} flex-1`} disabled={busy} onClick={() => void step("track")}>
                    {t("oo.track")}
                  </button>
                )}
              </div>
              {order.sellerState !== "Completed" && (
                <button type="button" className={`${PILL} w-full text-danger hover:bg-beige/60`} disabled={busy} onClick={() => setAskCancel(true)}>
                  {t("oo.cancel")}
                </button>
              )}
            </>
          )}
          {/* Once money has moved or the store has the order, there is something to complain about. */}
          {(order.paid || ["placed", "cancelled", "failed"].includes(order.status)) && (
            <Link href={`/orders/${order.id}/help`} className={`${PILL} w-full text-ink hover:bg-beige/60`}>
              <Headset size={15} /> {t("history.needHelp")}
            </Link>
          )}
          {actionFailed && <p className="text-center text-[13px] text-danger">{t("oo.failedAction")}</p>}
        </div>
      </div>

      {askCancel && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => !busy && setAskCancel(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="oo-cancel-title"
            className="w-full max-w-md rounded-t-[22px] bg-card p-5 sm:rounded-[22px]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="oo-cancel-title" className="text-[16px] font-bold text-acct-ink">{t("oo.cancelWhy")}</h2>
            <div className="mt-3 space-y-1.5">
              {REASONS.map((r) => (
                <label key={r} className="tap-target flex cursor-pointer items-center gap-3 rounded-[12px] border border-line px-3 py-2.5 text-[14px] text-acct-ink has-[:checked]:border-accent">
                  <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} className="accent-accent" />
                  {t(`oo.r.${r}` as TranslationKey)}
                </label>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" className={`${SOFT} flex-1`} disabled={busy} onClick={() => setAskCancel(false)}>
                {t("oo.keep")}
              </button>
              <button
                type="button"
                className={`${PILL} flex-1 bg-accent text-white hover:bg-[#d4570f]`}
                disabled={busy}
                onClick={async () => {
                  if (await step("cancel", { reasonId: reason })) setAskCancel(false);
                }}
              >
                {t("oo.cancelSend")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
