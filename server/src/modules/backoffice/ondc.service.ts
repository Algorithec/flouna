// ONDC (Beckn) transaction recording + viewer data. Flouna is a Buyer App
// (BAP); each order is a journey of signed request/callback pairs. Until we're a
// registered network participant these envelopes are SIMULATED from real orders,
// but recorded in the exact Beckn shape so the developer viewer — and any real
// integration later — works unchanged once PROVIDER_MODE flips to "ondc".

import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { BAP_URI } from "../ondc/context.js";

// ONDC domain codes for the categories we transact.
const DOMAIN_CODE: Record<string, string> = {
  food: "ONDC:RET11", // F&B
  // TRV10 is ride hailing, the domain we are registered for. TRV11 is a
  // different one (unreserved tickets such as metro and bus).
  ride: "ONDC:TRV10", // mobility
};

// A minimal, correctly-shaped Beckn context block. Real signing happens at the
// gateway once live; here `signed` records that the request WOULD carry an
// Ed25519 signature (true in both modes — we never log the key material).
function context(action: string, domain: string, txnId: string, messageId: string) {
  return {
    domain,
    country: "IND",
    city: "std:040", // Hyderabad STD as the demo region
    action,
    core_version: "1.2.0",
    bap_id: env.ONDC_SUBSCRIBER_ID ?? "flouna.bap.simulated",
    // Our real callback address. ONDC_BASE_URL names the gateway, not us.
    bap_uri: BAP_URI,
    transaction_id: txnId,
    message_id: messageId,
    timestamp: new Date().toISOString(),
  };
}

type Pair = {
  action: string; // request action; the callback is "on_" + action
  request: unknown; // message payload of the request
  response: unknown; // message payload of the callback
  status?: "ack" | "nack" | "error";
  latencyMs?: number;
};

// Record one request→callback pair as two rows sharing a message_id, so the
// viewer can show the round trip. Best-effort: never throws into the order flow.
async function recordPair(opts: {
  txnId: string;
  domain: string;
  orderId?: string | null;
  bppId?: string | null;
  pair: Pair;
}): Promise<void> {
  try {
    const messageId = crypto.randomUUID();
    const live = env.PROVIDER_MODE === "ondc";
    const reqCtx = context(opts.pair.action, opts.domain, opts.txnId, messageId);
    const resCtx = context(`on_${opts.pair.action}`, opts.domain, opts.txnId, messageId);

    await prisma.ondcTransaction.createMany({
      data: [
        {
          txnId: opts.txnId,
          messageId,
          action: opts.pair.action,
          domain: opts.domain,
          orderId: opts.orderId ?? undefined,
          bppId: opts.bppId ?? undefined,
          request: JSON.stringify({ context: reqCtx, message: opts.pair.request }),
          status: opts.pair.status ?? "ack",
          signed: true,
          latencyMs: opts.pair.latencyMs,
          simulated: !live,
        },
        {
          txnId: opts.txnId,
          messageId,
          action: `on_${opts.pair.action}`,
          domain: opts.domain,
          orderId: opts.orderId ?? undefined,
          bppId: opts.bppId ?? undefined,
          response: JSON.stringify({ context: resCtx, message: opts.pair.response }),
          status: opts.pair.status ?? "ack",
          signed: true,
          latencyMs: opts.pair.latencyMs,
          simulated: !live,
        },
      ],
    });
  } catch {
    // Logging the network log must never break the order it describes.
  }
}

// One deterministic transaction_id per order journey.
function txnForOrder(orderId: string): string {
  return crypto.createHash("sha256").update(orderId).digest("hex").slice(0, 32);
}

// Emitted at order creation: the buyer searched the network and selected an
// item (search/on_search + select/on_select).
export async function emitOrderDiscovery(order: {
  id: string;
  domain: string;
  provider: string;
  title: string;
  amount: number;
}): Promise<void> {
  const domain = DOMAIN_CODE[order.domain] ?? "ONDC:RET10";
  const txnId = txnForOrder(order.id);
  const bppId = `${order.provider}.bpp.simulated`;

  await recordPair({
    txnId,
    domain,
    orderId: order.id,
    bppId,
    pair: {
      action: "search",
      request: { intent: { item: { descriptor: { name: order.title } } } },
      response: { catalog: { "bpp/providers": [{ id: bppId }] } },
      latencyMs: 120 + Math.floor(Math.random() * 80),
    },
  });
  await recordPair({
    txnId,
    domain,
    orderId: order.id,
    bppId,
    pair: {
      action: "select",
      request: { order: { items: [{ descriptor: { name: order.title } }] } },
      response: { order: { quote: { price: { value: (order.amount / 100).toFixed(2), currency: "INR" } } } },
      latencyMs: 90 + Math.floor(Math.random() * 60),
    },
  });
}

// Emitted on payment success: the order is confirmed on the network and its
// fulfilment status is requested (confirm/on_confirm + status/on_status).
export async function emitOrderConfirmation(order: {
  id: string;
  domain: string;
  provider: string;
  amount: number;
}): Promise<void> {
  const domain = DOMAIN_CODE[order.domain] ?? "ONDC:RET10";
  const txnId = txnForOrder(order.id);
  const bppId = `${order.provider}.bpp.simulated`;

  await recordPair({
    txnId,
    domain,
    orderId: order.id,
    bppId,
    pair: {
      action: "confirm",
      request: {
        order: {
          id: order.id,
          payment: { status: "PAID", params: { amount: (order.amount / 100).toFixed(2), currency: "INR" } },
        },
      },
      response: { order: { id: order.id, state: "Accepted" } },
      latencyMs: 150 + Math.floor(Math.random() * 100),
    },
  });
  await recordPair({
    txnId,
    domain,
    orderId: order.id,
    bppId,
    pair: {
      action: "status",
      request: { order_id: order.id },
      response: { order: { id: order.id, state: "In-progress", fulfillments: [{ state: { descriptor: { code: "Order-picked-up" } } }] } },
      latencyMs: 80 + Math.floor(Math.random() * 60),
    },
  });
}

// ---- Viewer data --------------------------------------------------------

export async function listTransactions(opts: { action?: string; page?: number }) {
  const page = Math.max(1, opts.page ?? 1);
  const size = 50;
  const where = opts.action ? { action: opts.action } : {};
  const [rows, total, counts] = await Promise.all([
    prisma.ondcTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * size,
      take: size,
      select: {
        id: true,
        txnId: true,
        action: true,
        domain: true,
        bppId: true,
        status: true,
        signed: true,
        latencyMs: true,
        simulated: true,
        createdAt: true,
        orderId: true,
      },
    }),
    prisma.ondcTransaction.count({ where }),
    prisma.ondcTransaction.groupBy({ by: ["action"], _count: { _all: true } }),
  ]);
  return {
    transactions: rows,
    total,
    page,
    pageSize: size,
    mode: env.PROVIDER_MODE,
    byAction: Object.fromEntries(counts.map((c) => [c.action, c._count._all])),
  };
}

export async function getTransaction(id: string) {
  return prisma.ondcTransaction.findUnique({ where: { id } });
}
