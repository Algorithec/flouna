"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// One checkout machine, two surfaces.
//
// The payment screen and the payment step inside the chat take the same money
// the same way. Written twice, the second copy is the one that quietly misses
// the next fix to a gateway edge case, and the failures here are financial:
// a buyer charged and shown a retry, or an order marked paid that was not.
//
// So the sequence lives here once and both render it. What stays with each
// surface is layout, and only layout.

export type PayMethod = "upi" | "cash" | "card";
export type PayStage = "select" | "processing" | "done" | "failed";

export type CheckoutStatus = {
  orderStatus: string;
  /** The gross bill. The wallet is an instrument against it, not a discount. */
  amount: number;
  /** Reward credit already committed to this order. */
  walletAppliedPaise?: number;
  /** What the gateway still has to collect: amount − walletApplied. */
  payablePaise?: number;
  /** Spendable balance, only sent while the order can still take it. */
  walletBalancePaise?: number;
  title: string;
  domain: "food" | "ride";
  provider?: string;
  details?: {
    basePaise?: number;
    deliveryFeePaise?: number;
    convenienceFeePaise?: number;
    farePaise?: number;
    offers?: { label: string; discountPaise: number }[];
    items?: { name: string; qty: number; pricePaise: number }[];
    etaMinutes?: number;
    pickup?: string;
    drop?: string;
    displayName?: string;
  };
  payment: { status: string; method: string | null } | null;
};

export type FailedAttempt = { method: PayMethod; at: Date; message: string };

declare global {
  interface Window {
    Cashfree?: (config: { mode: string }) => {
      checkout: (opts: {
        paymentSessionId: string;
        redirectTarget: string;
      }) => Promise<unknown>;
    };
  }
}

const SDK_URL = "https://sdk.cashfree.com/js/v3/cashfree.js";

function loadCashfreeSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Cashfree) return resolve();
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment library"));
    document.head.appendChild(s);
  });
}

export function useCheckout(
  orderId: string,
  opts: {
    /** Localised fallback for a failure with no message of its own. */
    genericError?: string;
    /**
     * Where the gateway opens.
     *
     * "_self" navigates the tab away, which is fine for a screen that exists
     * only to take a payment. "_modal" keeps the page, which is the only way a
     * payment inside a conversation can leave the conversation standing.
     */
    redirectTarget?: "_self" | "_modal";
    /**
     * Which method the picker opens on.
     *
     * A surface that already asked the question passes the answer, so the
     * buyer is not asked it twice and given a different default the second
     * time. Group checkout asks on its own screen.
     */
    initialMethod?: PayMethod;
  } = {},
) {
  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [stage, setStage] = useState<PayStage>("select");
  const [method, setMethod] = useState<PayMethod>(opts.initialMethod ?? "upi");
  const [failed, setFailed] = useState<FailedAttempt | null>(null);
  const [paidWithCash, setPaidWithCash] = useState(false);
  const [error, setError] = useState("");
  /**
   * True while a checkout request is out.
   *
   * `stage` is not enough on its own: the processing screen offers a "taking
   * too long?" way back to the method picker, and from there the buyer can tap
   * Pay again while the first request is still open — two payment sessions for
   * one order. A ref rather than state because the guard has to hold within a
   * single tick.
   */
  const inFlight = useRef(false);

  // Verify, then load.
  //
  // A buyer returning from the Cashfree page is confirmed against Cashfree
  // directly rather than waiting on a webhook, so an order that is already
  // paid shows as paid instead of being offered payment a second time. A
  // no-op for unpaid and simulated orders.
  const load = useCallback(() => {
    api<{ orderStatus: string }>("/api/payments/verify", {
      method: "POST",
      json: { orderId },
    })
      .catch(() => null)
      .then(() => api<CheckoutStatus>(`/api/payments/status/${orderId}`))
      .then((s) => {
        setStatus(s);
        if (s.orderStatus !== "pending_payment") setStage("done");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [orderId]);
  useEffect(load, [load]);

  async function pay(payOpts: { useWallet?: boolean } = {}) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    setFailed(null);
    setStage("processing");
    try {
      const d = await api<{
        mode: "cashfree" | "simulated" | "cash" | "demo" | "wallet";
        paymentSessionId?: string;
        cfEnv?: string;
        walletAppliedPaise?: number;
      }>("/api/payments/checkout", {
        method: "POST",
        json: { orderId, method, useWallet: payOpts.useWallet },
      });

      // Covered entirely by reward credit — no gateway was involved, so the
      // order is already confirmed and there is nothing to wait for. Reload
      // rather than trust this response for the final numbers: the server is
      // still the one source of truth for what actually got spent.
      if (d.mode === "wallet") {
        load();
        setStage("done");
        return;
      }

      // Cash on delivery is settled in person, so it confirms immediately.
      // Tracked separately because `status` was read before any payment
      // existed and would otherwise still say "paid" by card.
      if (d.mode === "cash") {
        setPaidWithCash(true);
        setStage("done");
        return;
      }

      // Demo mode: the server settled it, so there is nothing to hand off to
      // and nowhere to redirect. Shows the same success the real flow does.
      if (d.mode === "demo") {
        setStage("done");
        return;
      }

      if (d.mode === "cashfree" && d.paymentSessionId) {
        await loadCashfreeSdk();
        const cashfree = window.Cashfree?.({
          mode: d.cfEnv === "production" ? "production" : "sandbox",
        });
        // An SDK that never loaded must not leave the buyer on "processing"
        // forever; hand the choice back instead.
        if (!cashfree) {
          throw new Error("Could not open the payment page. Please try again.");
        }
        const target = opts.redirectTarget ?? "_self";
        // With "_self" nothing below runs on the happy path, because the tab
        // has gone. With "_modal" the promise resolves either way and the
        // result has to be read.
        const result = (await cashfree.checkout({
          paymentSessionId: d.paymentSessionId,
          redirectTarget: target,
        })) as { error?: { message?: string } } | undefined;

        if (target === "_modal" && !result?.error) {
          // The SDK's success shape varies by version and method, so it is not
          // trusted to decide whether money moved. The server is asked, and
          // the server asks Cashfree. A modal that was closed after paying and
          // one closed before paying look similar from here and not at all
          // similar from there.
          const v = await api<{ orderStatus: string }>("/api/payments/verify", {
            method: "POST",
            json: { orderId },
          }).catch(() => null);
          if (v && v.orderStatus !== "pending_payment") {
            load();
            setStage("done");
            return;
          }
          throw new Error(
            "The payment was not completed. You can try again or pick another method.",
          );
        }

        throw new Error(
          result?.error?.message ??
            "Payment was not completed. You can try again or pick another method.",
        );
      }

      await new Promise((r) => setTimeout(r, 2400));
      await api("/api/payments/simulate", {
        method: "POST",
        json: { orderId, method: method === "cash" ? "upi" : method },
      });
      setStage("done");
    } catch (e) {
      // Every failure lands here: a declined card, an abandoned gateway page,
      // an SDK that never loaded. The buyer is told what was tried and when,
      // rather than shown one red line above the picker.
      setFailed({
        method,
        at: new Date(),
        message:
          e instanceof Error
            ? e.message
            : (opts.genericError ?? "Something went wrong taking the payment."),
      });
      setStage("failed");
    } finally {
      inFlight.current = false;
    }
  }

  /**
   * Clears a failed attempt and hands the choice back.
   *
   * Offered as an action rather than by exposing the setters, so a surface
   * cannot put the checkout into a state the sequence does not have, like a
   * cleared failure that is still showing the failure screen.
   */
  function reset() {
    setFailed(null);
    setError("");
    setStage("select");
  }

  return {
    status,
    stage,
    setStage,
    reset,
    method,
    setMethod,
    failed,
    paidWithCash,
    error,
    pay,
    reload: load,
  };
}
