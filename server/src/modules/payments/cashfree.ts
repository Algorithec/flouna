import crypto from "node:crypto";
import { env } from "../../config/env.js";

const BASE_URL =
  env.CASHFREE_ENV === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

const API_VERSION = "2023-08-01";

export const cashfreeConfigured = Boolean(
  env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY,
);

export async function createCashfreeOrder(opts: {
  orderId: string;
  amountPaise: number;
  customerId: string;
  customerEmail: string;
  customerPhone: string;
  returnUrl: string;
}) {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-version": API_VERSION,
      "x-client-id": env.CASHFREE_APP_ID!,
      "x-client-secret": env.CASHFREE_SECRET_KEY!,
    },
    body: JSON.stringify({
      order_id: opts.orderId,
      order_amount: (opts.amountPaise / 100).toFixed(2),
      order_currency: "INR",
      customer_details: {
        customer_id: opts.customerId,
        customer_email: opts.customerEmail,
        customer_phone: opts.customerPhone || "9999999999",
      },
      // NOTE: no notify_url here — per-order notify_url deliveries use Cashfree's
      // LEGACY webhook format (no x-webhook-* signature headers), which our
      // verifier rightly rejects. Webhooks come from the dashboard-registered
      // endpoint (new signed format); payment confirmation ALSO happens via the
      // authenticated verify-on-return path below, so no manual step blocks dev.
      order_meta: { return_url: opts.returnUrl },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(
      `Cashfree order create failed (${res.status}): ${body.slice(0, 300)}`,
    ) as Error & { cfStatus?: number };
    err.cfStatus = res.status;
    throw err;
  }
  return (await res.json()) as {
    cf_order_id: string;
    payment_session_id: string;
    order_status: string;
  };
}

// Authoritative order state straight from Cashfree — used to reuse an existing
// payment session on checkout retries, and to confirm payment server-side when
// the buyer returns from the gateway (independent of webhook delivery).
export async function getCashfreeOrder(orderId: string) {
  const res = await fetch(`${BASE_URL}/orders/${orderId}`, {
    headers: {
      "x-api-version": API_VERSION,
      "x-client-id": env.CASHFREE_APP_ID!,
      "x-client-secret": env.CASHFREE_SECRET_KEY!,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cashfree order fetch failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as {
    cf_order_id: string;
    order_status: string; // "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" ...
    order_amount: number; // rupees
    payment_session_id: string;
  };
}

// Initiate a refund with the gateway. `refundId` is our idempotency key —
// Cashfree rejects a duplicate refund_id for the same order, so a double
// approval can never move money twice. Sandbox refunds typically return
// PENDING and settle asynchronously; both SUCCESS and PENDING mean the
// gateway accepted the refund.
export async function createCashfreeRefund(opts: {
  orderId: string;
  refundId: string;
  amountRupees: number;
  note?: string;
}) {
  const res = await fetch(`${BASE_URL}/orders/${opts.orderId}/refunds`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-version": API_VERSION,
      "x-client-id": env.CASHFREE_APP_ID!,
      "x-client-secret": env.CASHFREE_SECRET_KEY!,
    },
    body: JSON.stringify({
      refund_id: opts.refundId,
      refund_amount: opts.amountRupees,
      refund_note: opts.note ?? "Refund approved from Radiues console",
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Cashfree refund failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as {
    cf_refund_id: number | string;
    refund_id: string;
    refund_status: string; // "SUCCESS" | "PENDING" | "ONHOLD" | "CANCELLED"
    refund_amount: number;
  };
}

// Reject webhooks whose timestamp is older than this — blocks replay of a
// captured-but-valid delivery. Cashfree sends epoch-second timestamps.
const WEBHOOK_MAX_AGE_MS = 5 * 60_000;

// Webhook authenticity: HMAC-SHA256(timestamp + rawBody, secret) must match
// the signature header, AND the timestamp must be recent (anti-replay).
export function verifyCashfreeWebhook(
  rawBody: string,
  signature: string,
  timestamp: string,
): boolean {
  if (!env.CASHFREE_SECRET_KEY || !timestamp || !signature) return false;

  // Anti-replay: timestamp must be a recent epoch-second value.
  const tsMs = Number(timestamp) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > WEBHOOK_MAX_AGE_MS) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", env.CASHFREE_SECRET_KEY)
    .update(timestamp + rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
