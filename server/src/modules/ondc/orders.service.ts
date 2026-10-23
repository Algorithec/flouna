import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { commercialTerms } from "./commercial.js";
import { readOnInit, readOnSelect, readOrderState, readQuote, type PaymentTerms, type Quote } from "./orderReplies.js";
import {
  buildCancel,
  buildConfirm,
  buildInit,
  buildSelect,
  buildStatus,
  buildTrack,
  type Address,
  type BuyerCancelReason,
  type CartLine,
} from "./retail.js";
import { ondcSearchResults } from "./search.service.js";
import { checkChoices, optionsFor, type OptionTree } from "./catalog.js";
import { owe, recordPayout, refundAfterCancel } from "./ondcMoney.js";
import { recordTermsAcceptance, statesAcceptance } from "./termsAcceptance.js";
import type { SigningIdentity } from "./signing.js";
import { sendSigned, type SendResult } from "./transport.js";

// Placing a food order with an ONDC seller.
//
// Every step is a request we send and an answer the seller sends back later,
// signed, to our callback endpoint:
//
//   select   -> on_select    the price of this cart, delivered here
//   init     -> on_init      final terms: who collects, where the seller is paid
//   (the customer pays)
//   confirm  -> on_confirm   the seller's order id and acceptance
//   status   -> on_status    where the order has got to; sellers also send
//   cancel   -> on_cancel    these unasked as the order moves
//
// The order row says which step we are waiting on and the message_id we sent
// for it. An answer is applied only if it comes from the seller we chose, for
// this transaction, answering that message. Anything else is still stored by
// the callbacks router, but changes nothing here.

/**
 * Sends a signed message. `url` is the seller app's registered base URI:
 * sendSigned adds the action itself, so ".../select" here would be posted
 * to ".../select/select".
 */
type Send = (url: string, action: string, envelope: { context: Record<string, unknown>; message: unknown }, id: SigningIdentity) => Promise<SendResult>;

export type OrderDeps = {
  send?: Send;
  identity?: () => SigningIdentity | null;
  now?: () => Date;
};

function defaultIdentity(): SigningIdentity | null {
  return env.ONDC_SUBSCRIBER_ID && env.ONDC_UNIQUE_KEY_ID && env.ONDC_SIGNING_PRIVATE_KEY
    ? { subscriberId: env.ONDC_SUBSCRIBER_ID, uniqueKeyId: env.ONDC_UNIQUE_KEY_ID, signingPrivateKey: env.ONDC_SIGNING_PRIVATE_KEY }
    : null;
}

export type OrderRow = NonNullable<Awaited<ReturnType<typeof prisma.ondcOrder.findUnique>>>;

/**
 * Sends one request for an order and records which answer we now wait for.
 * The row is moved to `waiting` before sending, so an answer that arrives
 * before the send returns finds the order expecting it.
 */
async function sendStep(
  order: OrderRow,
  action: string,
  envelope: { context: Record<string, unknown>; message: unknown },
  waiting: string,
  deps: OrderDeps,
  extra: Record<string, unknown> = {},
) {
  const id = (deps.identity ?? defaultIdentity)();
  if (!id) throw new ApiError(503, "ONDC is not configured on this deployment");
  const messageId = envelope.context.message_id as string;
  await prisma.ondcOrder.update({ where: { id: order.id }, data: { status: waiting, awaitingMsgId: messageId, problem: null, ...extra } });
  let result: SendResult;
  try {
    result = await (deps.send ?? ((u, a, e, i) => sendSigned(u, a, e, i)))(order.bppUri, action, envelope, id);
  } catch (err) {
    result = { ack: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
  await prisma.ondcTransaction.create({
    data: {
      txnId: order.txnId,
      messageId,
      action,
      domain: "ONDC:RET11",
      orderId: order.id,
      bppId: order.bppId,
      request: JSON.stringify(envelope),
      status: result.ack ? "ack" : "nack",
      signed: true,
      simulated: false,
    },
  });
  if (!result.ack) {
    const problem = "The seller's app did not accept the request. Try again in a moment.";
    // Only if nothing has answered meanwhile: a fast reply has already moved it on.
    await prisma.ondcOrder.updateMany({ where: { id: order.id, awaitingMsgId: messageId, status: waiting }, data: { status: failedStatusFor(waiting), problem } });
  }
  return result.ack;
}

/** Where an order falls back to when a step could not be sent. */
function failedStatusFor(waiting: string) {
  if (waiting === "selecting") return "unavailable";
  if (waiting === "initialising") return "quoted";
  if (waiting === "confirming") return "paid";
  if (waiting === "cancelling") return "placed";
  return waiting;
}

async function ownOrder(userId: string, id: string) {
  const order = await prisma.ondcOrder.findUnique({ where: { id } });
  if (!order || order.userId !== userId) throw new ApiError(404, "Order not found");
  return order;
}

export type StartInput = {
  searchId: string;
  bppId: string;
  providerId: string;
  locationId: string;
  /** Dishes and the option ids chosen for each; groups and line ids are filled in from the catalogue. */
  lines: { itemId: string; count: number; customizations?: { itemId: string; groupId?: string }[] }[];
  addressId?: string;
};

/**
 * Starts an order from a search: checks every item came from that seller's
 * answer to this customer's search, then asks the seller to price the cart.
 */
export async function startOndcOrder(userId: string, input: StartInput, deps: OrderDeps = {}) {
  if (input.lines.length === 0 || input.lines.length > 30) throw new ApiError(400, "An order needs between 1 and 30 items");
  // Checked before anything is stored, so a deployment without an ONDC
  // identity does not leave an order waiting on a price that never comes.
  if (!(deps.identity ?? defaultIdentity)()) throw new ApiError(503, "ONDC is not configured on this deployment");
  // Every confirm carries Algorithec's GSTIN. Without it an order could be
  // priced and paid for and then never placed, so none is started.
  if (!commercialTerms().gstin) throw new ApiError(503, "Food ordering on ONDC is not set up on this deployment yet");
  const results = await ondcSearchResults(input.searchId, userId);
  const fromSeller = results.offers.filter(
    (o) => o.seller.bppId === input.bppId && o.seller.providerId === input.providerId && o.seller.locationId === input.locationId,
  );
  if (fromSeller.length === 0) throw new ApiError(400, "That store was not in your search results");
  const listed = new Set(fromSeller.map((o) => o.itemId));
  // Only the dishes themselves can be checked against the search: add-ons
  // live in the seller's customisation groups, which the seller prices in
  // on_select.
  for (const l of input.lines) {
    if (!listed.has(l.itemId)) throw new ApiError(400, `Item ${l.itemId} is not on that store's menu`);
  }
  // Options are checked against the seller's own rules (one crust, up to two
  // toppings) before anything is sent, and the group each one belongs to is
  // taken from the catalogue, not from the request. Each dish with options
  // gets its own line id, which ties the options to it on the wire.
  const lines: CartLine[] = [];
  for (const l of input.lines) {
    const tree = await dishOptions(userId, input.searchId, input.bppId, input.providerId, l.itemId);
    const chosen = (l.customizations ?? []).map((c) => c.itemId);
    if (!tree) {
      if (chosen.length) throw new ApiError(400, `${l.itemId} has no options to choose`);
      lines.push({ itemId: l.itemId, count: l.count });
      continue;
    }
    const checked = checkChoices(tree, chosen);
    if ("problem" in checked) throw new ApiError(400, checked.problem);
    lines.push({ itemId: l.itemId, count: l.count, parentItemId: crypto.randomBytes(5).toString("hex"), customizations: checked.picks });
  }
  const address = await prisma.address.findFirst({
    where: input.addressId ? { id: input.addressId, userId } : { userId, isDefault: true },
  });
  if (!address) throw new ApiError(400, "Add a delivery address first");
  if (address.lat == null || address.lng == null) throw new ApiError(400, "Your delivery address has no map location");

  const search = await prisma.ondcSearch.findUnique({ where: { id: input.searchId }, select: { city: true, termsUrl: true, termsEffective: true } });
  const seller = fromSeller[0]!.seller;
  const gps = `${address.lat.toFixed(6)},${address.lng.toFixed(6)}`;
  const order = await prisma.ondcOrder.create({
    data: {
      userId,
      txnId: crypto.randomUUID(),
      status: "selecting",
      bppId: seller.bppId,
      bppUri: seller.bppUri,
      providerId: seller.providerId,
      locationId: seller.locationId,
      storeName: seller.name,
      city: search!.city,
      lines: JSON.stringify(lines),
      addressId: address.id,
      gps,
      areaCode: address.pincode,
      termsUrl: search!.termsUrl,
      termsEffective: search!.termsEffective,
    },
  });
  const envelope = buildSelect({
    transactionId: order.txnId,
    city: order.city,
    bpp: { id: order.bppId, uri: order.bppUri },
    providerId: order.providerId,
    locationId: order.locationId,
    lines,
    gps,
    areaCode: address.pincode,
  });
  await sendStep(order, "select", envelope, "selecting", deps);
  return { orderId: order.id };
}

export async function billingFor(order: OrderRow) {
  const [user, address] = await Promise.all([
    prisma.user.findUnique({ where: { id: order.userId }, select: { name: true, email: true, phone: true } }),
    order.addressId ? prisma.address.findUnique({ where: { id: order.addressId } }) : null,
  ]);
  if (!user || !address) throw new ApiError(400, "The delivery address for this order no longer exists");
  const phone = (address.contactPhone ?? user.phone ?? "").replace(/^\+91/, "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(phone)) throw new ApiError(400, "Add a 10 digit phone number so the seller can reach you");
  const wire: Address = {
    name: address.contactName ?? user.name,
    building: address.line1,
    locality: address.line2 ?? address.landmark ?? address.city,
    city: address.city,
    state: address.state,
    areaCode: address.pincode,
  };
  return { name: user.name, personName: address.contactName ?? user.name, email: user.email, phone, address: wire };
}

/** Sends the customer's details so the seller can return final terms. Allowed once priced. */
export async function initOndcOrder(userId: string, id: string, deps: OrderDeps = {}) {
  const order = await ownOrder(userId, id);
  if (order.status !== "quoted") throw new ApiError(409, `This order is ${order.status}, not waiting for your details`);
  const b = await billingFor(order);
  const envelope = buildInit({
    transactionId: order.txnId,
    city: order.city,
    bpp: { id: order.bppId, uri: order.bppUri },
    providerId: order.providerId,
    locationId: order.locationId,
    lines: JSON.parse(order.lines) as CartLine[],
    billing: { name: b.name, phone: b.phone, email: b.email, address: b.address, at: order.createdAt },
    delivery: { fulfillmentId: order.fulfillmentId!, gps: order.gps!, address: b.address, phone: b.phone, email: b.email },
  });
  await sendStep(order, "init", envelope, "initialising", deps);
  return { orderId: order.id };
}

/**
 * Records that the customer paid the seller's final total. The caller is the
 * payment flow, once its gateway has confirmed the money; the amount must be
 * the total from on_init, or the order would be confirmed at a price nobody
 * agreed.
 */
export async function markOndcOrderPaid(id: string, payment: { amountPaise: number; reference: string; at?: Date }) {
  const order = await prisma.ondcOrder.findUnique({ where: { id } });
  if (!order) throw new ApiError(404, "Order not found");
  if (order.status !== "ready_to_pay") throw new ApiError(409, `This order is ${order.status}, not waiting for payment`);
  if (payment.amountPaise !== order.totalPaise) throw new ApiError(409, "The amount paid does not match the seller's total");
  const done = await prisma.ondcOrder.updateMany({
    where: { id, status: "ready_to_pay" },
    data: { status: "paid", paidAt: payment.at ?? new Date(), paymentRef: payment.reference, paidPaise: payment.amountPaise },
  });
  if (done.count === 0) throw new ApiError(409, "This order changed while it was being paid");
}

/** Places the paid order with the seller, on exactly the terms it returned in on_init. */
export async function confirmOndcOrder(userId: string, id: string, deps: OrderDeps = {}) {
  const order = await ownOrder(userId, id);
  if (order.status !== "paid") throw new ApiError(409, `This order is ${order.status}, not ready to place`);
  const b = await billingFor(order);
  const quote = JSON.parse(order.quote!) as unknown;
  const terms = JSON.parse(order.payment!) as PaymentTerms;
  const commercial = commercialTerms();
  if (!commercial.gstin) throw new ApiError(503, "Food ordering on ONDC is not set up on this deployment yet");
  const envelope = buildConfirm({
    transactionId: order.txnId,
    city: order.city,
    bpp: { id: order.bppId, uri: order.bppUri },
    providerId: order.providerId,
    locationId: order.locationId,
    lines: JSON.parse(order.lines) as CartLine[],
    // Our own id for the order: the seller answers with its id, kept separately.
    orderId: order.id,
    billing: { name: b.name, phone: b.phone, email: b.email, address: b.address, at: order.createdAt },
    delivery: { fulfillmentId: order.fulfillmentId!, gps: order.gps!, address: b.address, phone: b.phone, email: b.email, personName: b.personName, tat: order.tat ?? "PT60M" },
    quote,
    payment: {
      collectedBy: terms.collectedBy,
      amountPaise: order.totalPaise!,
      gatewayTransactionId: order.paymentRef ?? undefined,
      paid: Boolean(order.paidAt),
      finderFeePercent: commercial.finderFeePercent,
      settlementDetails: terms.settlementDetails,
    },
    terms: { seller: terms.sellerTerms ?? [], buyerGstin: commercial.gstin },
  });
  await sendStep(order, "confirm", envelope, "confirming", deps);
  return { orderId: order.id };
}

/**
 * A question about a placed order (status, track) whose answer changes no
 * step: it is sent and logged, and the seller's reply is read when it lands.
 */
async function askAboutOrder(userId: string, id: string, action: "status" | "track", deps: OrderDeps) {
  const order = await ownOrder(userId, id);
  if (!order.sellerOrderId) throw new ApiError(409, "This order has not been placed with the seller yet");
  const ident = (deps.identity ?? defaultIdentity)();
  if (!ident) throw new ApiError(503, "ONDC is not configured on this deployment");
  const args = { transactionId: order.txnId, city: order.city, bpp: { id: order.bppId, uri: order.bppUri }, orderId: order.sellerOrderId };
  const envelope = action === "status" ? buildStatus(args) : buildTrack(args);
  const result = await (deps.send ?? ((u, a, e, i) => sendSigned(u, a, e, i)))(order.bppUri, action, envelope, ident).catch(
    (err: unknown) => ({ ack: false as const, status: 0, error: String(err) }),
  );
  await prisma.ondcTransaction.create({
    data: { txnId: order.txnId, messageId: envelope.context.message_id as string, action, domain: "ONDC:RET11", orderId: order.id, bppId: order.bppId, request: JSON.stringify(envelope), status: result.ack ? "ack" : "nack", signed: true, simulated: false },
  });
  return { asked: result.ack };
}

/** Asks the seller where a placed order has got to. The answer arrives as on_status. */
export function refreshOndcOrder(userId: string, id: string, deps: OrderDeps = {}) {
  return askAboutOrder(userId, id, "status", deps);
}

/** Asks the seller for a live tracking link. The answer arrives as on_track. */
export function trackOndcOrder(userId: string, id: string, deps: OrderDeps = {}) {
  return askAboutOrder(userId, id, "track", deps);
}

/**
 * The latest tracking link the order's own seller sent. Read from the stored,
 * signature checked on_track, never from a message signed by anyone else.
 */
async function trackingFor(order: OrderRow): Promise<{ url: string; status?: string } | null> {
  const row = await prisma.ondcTransaction.findFirst({
    where: { txnId: order.txnId, action: "on_track", bppId: order.bppId },
    orderBy: { createdAt: "desc" },
    select: { response: true },
  });
  if (!row?.response) return null;
  try {
    const t = (JSON.parse(row.response) as { message?: { tracking?: { url?: unknown; status?: unknown } } }).message?.tracking;
    const url = typeof t?.url === "string" && /^https:\/\//.test(t.url) ? t.url : null;
    if (!url) return null;
    return { url, ...(typeof t?.status === "string" ? { status: t.status } : {}) };
  } catch {
    return null;
  }
}

/** Asks the seller to cancel. The seller decides, and answers with on_cancel. */
export async function cancelOndcOrder(userId: string, id: string, reasonId: BuyerCancelReason, deps: OrderDeps = {}) {
  const order = await ownOrder(userId, id);
  if (order.status !== "placed" || !order.sellerOrderId) throw new ApiError(409, `This order is ${order.status} and cannot be cancelled with the seller`);
  if (order.sellerState === "Completed" || order.sellerState === "Cancelled") throw new ApiError(409, `This order is already ${order.sellerState.toLowerCase()}`);
  const envelope = buildCancel({ transactionId: order.txnId, city: order.city, bpp: { id: order.bppId, uri: order.bppUri }, orderId: order.sellerOrderId, reasonId });
  await sendStep(order, "cancel", envelope, "cancelling", deps, { cancelReasonId: reasonId });
  return { orderId: order.id };
}

// ---------------------------------------------------------------------------
// Applying the seller's answers

const ORDER_ACTIONS = new Set(["on_select", "on_init", "on_confirm", "on_status", "on_cancel", "on_update"]);

export type AppliedOutcome = "applied" | "ignored";

/**
 * Applies a verified seller message to its order. Called by the callbacks
 * router after the message is stored and signature checked; `senderId` is the
 * verified signer. Idempotent: the same message applied twice changes nothing
 * the second time.
 */
export async function applyRetailReply(cb: { action: string; body: Record<string, unknown>; senderId: string }): Promise<AppliedOutcome> {
  if (!ORDER_ACTIONS.has(cb.action)) return "ignored";
  const ctx = (cb.body.context ?? {}) as Record<string, unknown>;
  if (ctx.domain !== "ONDC:RET11" || typeof ctx.transaction_id !== "string") return "ignored";
  const order = await prisma.ondcOrder.findUnique({ where: { txnId: ctx.transaction_id } });
  // Another participant cannot move our order by naming its transaction.
  if (!order || order.bppId !== cb.senderId) return "ignored";
  const answers = (step: string) => order.status === step && ctx.message_id === order.awaitingMsgId;

  if (cb.action === "on_select") {
    if (!answers("selecting")) return "ignored";
    const r = readOnSelect(cb.body);
    if ("problem" in r) {
      await prisma.ondcOrder.update({ where: { id: order.id }, data: { status: "unavailable", problem: r.problem, awaitingMsgId: null } });
      return "applied";
    }
    await prisma.ondcOrder.update({
      where: { id: order.id },
      data: {
        status: r.outOfStock.length ? "unavailable" : "quoted",
        // Named as the store names them in its quote, not by its item ids.
        problem: r.outOfStock.length
          ? `Out of stock: ${r.outOfStock.map((id) => r.quote.lines.find((l) => l.itemId === id && l.title)?.title ?? id).join(", ")}`
          : null,
        quote: JSON.stringify((cb.body.message as { order: { quote: unknown } }).order.quote),
        totalPaise: r.quote.totalPaise,
        fulfillmentId: r.fulfillment.id,
        tat: r.fulfillment.tat ?? null,
        awaitingMsgId: null,
      },
    });
    return "applied";
  }

  if (cb.action === "on_init") {
    if (!answers("initialising")) return "ignored";
    const r = readOnInit(cb.body);
    if ("problem" in r) {
      await prisma.ondcOrder.update({ where: { id: order.id }, data: { status: "quoted", problem: r.problem, awaitingMsgId: null } });
      return "applied";
    }
    // The customer pays what on_init says, which may differ from on_select.
    // The difference is shown before paying (see orderView), never absorbed.
    await prisma.ondcOrder.update({
      where: { id: order.id },
      data: { status: "ready_to_pay", quote: JSON.stringify(r.raw.quote), totalPaise: r.quote.totalPaise, payment: JSON.stringify(r.payment), awaitingMsgId: null, problem: null },
    });
    return "applied";
  }

  // on_confirm, on_status, on_cancel, on_update: the order's state.
  const r = readOrderState(cb.body);
  if (cb.action === "on_confirm") {
    if (!answers("confirming")) return "ignored";
    if ("problem" in r) {
      // Paid but not placed: the money has to go back, so this is recorded as
      // a failure the payment flow refunds, never left looking like progress.
      await prisma.ondcOrder.update({ where: { id: order.id }, data: { status: "failed", problem: r.problem, awaitingMsgId: null } });
      if (order.paidPaise) await owe(order.id, { paise: order.paidPaise });
      return "applied";
    }
    // The seller's settlement terms arrive with its acceptance: when, and
    // counted from what, it expects to be paid.
    const pay = ((cb.body.message as { order?: { payment?: Record<string, unknown> } }).order?.payment ?? {}) as Record<string, unknown>;
    const terms = { ...(JSON.parse(order.payment ?? "{}") as Record<string, unknown>) };
    if (typeof pay["@ondc/org/settlement_window"] === "string") terms.settlementWindow = pay["@ondc/org/settlement_window"];
    if (typeof pay["@ondc/org/settlement_basis"] === "string") terms.settlementBasis = pay["@ondc/org/settlement_basis"];
    await prisma.ondcOrder.update({
      where: { id: order.id },
      data: {
        payment: JSON.stringify(terms),
        status: r.sellerState === "Cancelled" ? "failed" : "placed",
        problem: r.sellerState === "Cancelled" ? "The seller did not accept the order" : null,
        sellerOrderId: r.sellerOrderId,
        sellerState: r.sellerState,
        fulfillmentState: r.fulfillmentState ?? null,
        sellerUpdatedAt: r.at ?? null,
        awaitingMsgId: null,
      },
    });
    if (r.sellerState === "Cancelled" && order.paidPaise) await owe(order.id, { paise: order.paidPaise });
    // The seller took an order placed under our stated terms: that is its
    // acceptance of them (static terms 17.6.1).
    if (r.sellerState !== "Cancelled" && order.termsUrl && order.termsEffective) {
      await recordTermsAcceptance({
        bppId: order.bppId,
        termsUrl: order.termsUrl,
        termsEffective: order.termsEffective,
        orderId: order.id,
        messageId: String(ctx.message_id),
        at: r.at ?? new Date(),
        statedAccept: statesAcceptance(cb.body),
      });
    }
    return "applied";
  }

  // Unsolicited updates only make sense once the seller has the order, and
  // must be about that order.
  if ("problem" in r || !order.sellerOrderId || r.sellerOrderId !== order.sellerOrderId) {
    if (cb.action === "on_cancel" && "problem" in r && answers("cancelling")) {
      await prisma.ondcOrder.update({ where: { id: order.id }, data: { status: "placed", problem: r.problem, awaitingMsgId: null } });
      return "applied";
    }
    return "ignored";
  }
  // Older than what we have: a slow copy of an earlier state.
  if (r.at && order.sellerUpdatedAt && r.at < order.sellerUpdatedAt) return "ignored";
  // A cancel the seller answered without cancelling was refused: the order
  // carries on. Any other update leaves our step as it was.
  const refusedCancel = cb.action === "on_cancel" && order.status === "cancelling" && r.sellerState !== "Cancelled";
  const status = r.sellerState === "Cancelled" ? "cancelled" : refusedCancel ? "placed" : order.status;
  await prisma.ondcOrder.update({
    where: { id: order.id },
    data: {
      status,
      ...(refusedCancel ? { problem: "The seller did not agree to cancel this order" } : {}),
      sellerState: r.sellerState,
      fulfillmentState: r.fulfillmentState ?? order.fulfillmentState,
      sellerUpdatedAt: r.at ?? order.sellerUpdatedAt,
      ...(r.cancelReasonId ? { cancelReasonId: r.cancelReasonId } : {}),
      ...(cb.action === "on_cancel" ? { awaitingMsgId: null } : {}),
      ...(r.quote ? { totalPaise: r.quote.totalPaise, quote: JSON.stringify((cb.body.message as { order: { quote: unknown } }).order.quote) } : {}),
      ...(r.sellerState === "Completed" && !order.completedAt ? { completedAt: r.at ?? new Date() } : {}),
    },
  });
  if (r.sellerState === "Cancelled" && order.paidPaise) {
    await owe(order.id, refundAfterCancel({ paidPaise: order.paidPaise, cancelledBySeller: r.cancelledBy === order.bppId, finalTotalPaise: r.quote?.totalPaise }));
  } else if (order.paidPaise && r.quote && r.quote.totalPaise < order.paidPaise) {
    // The seller cut the bill on an order it is still fulfilling (it could
    // not supply an item, say). The customer is owed the difference. Several
    // such cuts can come on one order, each needing its own refund, so for
    // now this goes to a person with both amounts rather than move money.
    await owe(order.id, {
      review: `The seller reduced the bill from ${order.paidPaise / 100} to ${r.quote.totalPaise / 100} rupees; refund the difference`,
    });
  }
  if (r.sellerState === "Completed") await recordPayout(order.id, order.completedAt ?? r.at ?? new Date());
  return "applied";
}

// ---------------------------------------------------------------------------
// What the app shows

export type OndcOrderView = {
  id: string;
  status: string;
  store: string;
  problem: string | null;
  totalPaise: number | null;
  quote: Quote | null;
  sellerOrderId: string | null;
  sellerState: string | null;
  fulfillmentState: string | null;
  paid: boolean;
  tracking: { url: string; status?: string } | null;
  /** Money on its way back to the customer, when any is owed. */
  refund: { status: string; paise: number | null } | null;
  createdAt: string;
};

export async function ondcOrderView(userId: string, id: string): Promise<OndcOrderView> {
  const o = await ownOrder(userId, id);
  const q = o.quote ? readQuote(JSON.parse(o.quote)) : null;
  return {
    id: o.id,
    status: o.status,
    store: o.storeName,
    problem: o.problem,
    totalPaise: o.totalPaise,
    quote: q && !("problem" in q) ? q : null,
    sellerOrderId: o.sellerOrderId,
    sellerState: o.sellerState,
    fulfillmentState: o.fulfillmentState,
    paid: Boolean(o.paidAt),
    tracking: o.sellerOrderId ? await trackingFor(o) : null,
    refund: o.refundStatus ? { status: o.refundStatus, paise: o.refundPaise } : null,
    createdAt: o.createdAt.toISOString(),
  };
}

/**
 * The options a dish has, read from the catalogue its seller sent in answer
 * to this customer's search (the latest one, if the seller refreshed it).
 * Null when the dish has none.
 */
export async function dishOptions(userId: string, searchId: string, bppId: string, providerId: string, itemId: string): Promise<OptionTree | null> {
  const search = await prisma.ondcSearch.findUnique({ where: { id: searchId }, select: { userId: true } });
  if (!search || search.userId !== userId) throw new ApiError(404, "Search not found");
  const rows = await prisma.ondcTransaction.findMany({
    where: { txnId: searchId, action: "on_search", bppId },
    orderBy: { createdAt: "desc" },
    select: { response: true },
    take: 5,
  });
  for (const row of rows) {
    try {
      const tree = optionsFor(JSON.parse(row.response ?? "null"), providerId, itemId);
      if (tree) return tree;
    } catch {
      // A catalogue that does not parse has no options to offer.
    }
  }
  return null;
}
