import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { durationMs } from "./ondcMoney.js";
import { ApiError } from "../../middleware/error.js";
import { commercialTerms } from "./commercial.js";
import { buildRideCancel, buildRideConfirm, buildRideInit, buildRideSearch, buildRideSelect, buildRideStatus, buildRideTrack, type Stop, type VehicleCategory } from "./mobility.js";
import { parseRideOnSearch, readRideOnInit, readRideOnSelect, readRideState, readRideTrack, type RideOffer, type RidePaymentTerms } from "./rideReplies.js";
import { stdCodeFor } from "./search.service.js";
import type { SigningIdentity } from "./signing.js";
import { sendSigned, type SendResult } from "./transport.js";
import { searchUrl } from "./workbench.js";
import { fareChangedProblem, PROBLEM, problemCode } from "./problems.js";

// Booking a ride with an ONDC ride provider (TRV10 2.0.1).
//
//   search  -> on_search    every provider's rides between the two points
//   select  -> on_select    the fare for the one chosen
//   init    -> on_init      who rides, and the provider's payment terms
//   confirm -> on_confirm   booked; the driver follows in on_status/on_update
//   cancel  -> on_cancel    twice: SOFT_CANCEL quotes the fee, CONFIRM_CANCEL cancels
//
// One transaction runs from the search to the end of the ride, so the row is
// created with the search. The provider collects the fare (cash or its own
// link), and Flouna is owed its finder fee into the account in the payment
// params. As with food, a reply only moves a ride when it comes from the
// provider chosen and answers the request we are waiting on.

/**
 * Sends a signed message. `url` is the provider's (or the gateway's) base
 * URI: sendSigned adds the action itself, so ".../select" here would be
 * posted to ".../select/select".
 */
type Send = (url: string, action: string, envelope: { context: Record<string, unknown>; message: unknown }, id: SigningIdentity) => Promise<SendResult>;
export type RideDeps = { send?: Send; identity?: () => SigningIdentity | null };

/** The rider's reasons ONDC lists for cancelling (TRV10 cancel enum, buyer side). */
export const RIDER_CANCEL_REASONS = {
  "001": "Driver not moving",
  "002": "Unable to contact the driver",
  "003": "Driver asked to cancel",
  "004": "Pickup location is wrong",
} as const;
export type RiderCancelReason = keyof typeof RIDER_CANCEL_REASONS;

export const RIDE_SEARCH_WINDOW_MS = 30_000;

function defaultIdentity(): SigningIdentity | null {
  return env.ONDC_SUBSCRIBER_ID && env.ONDC_UNIQUE_KEY_ID && env.ONDC_SIGNING_PRIVATE_KEY
    ? { subscriberId: env.ONDC_SUBSCRIBER_ID, uniqueKeyId: env.ONDC_UNIQUE_KEY_ID, signingPrivateKey: env.ONDC_SIGNING_PRIVATE_KEY }
    : null;
}

type RideRow = NonNullable<Awaited<ReturnType<typeof prisma.ondcRide.findUnique>>>;

async function ownRide(userId: string, id: string) {
  const ride = await prisma.ondcRide.findUnique({ where: { id } });
  if (!ride || ride.userId !== userId) throw new ApiError(404, "Ride not found");
  return ride;
}

/** Where a step falls back to when its request could not be sent. */
const fallback: Record<string, string> = {
  selecting: "searching",
  initialising: "quoted",
  confirming: "ready",
  cancel_quoting: "booked",
  cancelling: "cancel_quoted",
};

async function sendStep(ride: RideRow, action: string, envelope: { context: Record<string, unknown>; message: unknown }, waiting: string | null, deps: RideDeps, url: string) {
  const id = (deps.identity ?? defaultIdentity)();
  if (!id) throw new ApiError(503, "ONDC is not configured on this deployment");
  const messageId = envelope.context.message_id as string;
  if (waiting) await prisma.ondcRide.update({ where: { id: ride.id }, data: { status: waiting, awaitingMsgId: messageId, problem: null } });
  let result: SendResult;
  try {
    result = await (deps.send ?? ((u, a, e, i) => sendSigned(u, a, e, i)))(url, action, envelope, id);
  } catch (err) {
    result = { ack: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
  await prisma.ondcTransaction.create({
    data: {
      txnId: ride.txnId,
      messageId,
      action,
      domain: "ONDC:TRV10",
      bppId: ride.bppId,
      request: JSON.stringify(envelope),
      status: result.ack ? "ack" : "nack",
      signed: true,
      simulated: false,
    },
  });
  if (!result.ack && waiting) {
    await prisma.ondcRide.updateMany({
      where: { id: ride.id, awaitingMsgId: messageId, status: waiting },
      data: { status: fallback[waiting] ?? waiting, problem: PROBLEM.providerUnreachable },
    });
  }
  return result.ack;
}

const stopOf = (s: string) => JSON.parse(s) as Stop;

export type PlaceInput = { lat: number; lng: number; address: string; area: string };

/**
 * City centres for the cities ONDC rides can be searched in, by STD code.
 * The rides screen knows where the rider is, not which city's code ONDC
 * files that under, so the nearest centre within 40 km decides.
 */
const CITY_CENTRES: [string, number, number][] = [
  ["std:080", 12.9716, 77.5946], // Bengaluru
  ["std:040", 17.385, 78.4867], // Hyderabad
  ["std:011", 28.6139, 77.209], // Delhi
  ["std:0120", 28.5355, 77.391], // Noida
  ["std:0124", 28.4595, 77.0266], // Gurugram
  ["std:022", 19.076, 72.8777], // Mumbai
  ["std:044", 13.0827, 80.2707], // Chennai
  ["std:033", 22.5726, 88.3639], // Kolkata
  ["std:020", 18.5204, 73.8567], // Pune
  ["std:079", 23.0225, 72.5714], // Ahmedabad
  ["std:0141", 26.9124, 75.7873], // Jaipur
  ["std:0522", 26.8467, 80.9462], // Lucknow
  ["std:0172", 30.7333, 76.7794], // Chandigarh
  ["std:0484", 9.9312, 76.2673], // Kochi
  ["std:0422", 11.0168, 76.9558], // Coimbatore
  ["std:0891", 17.6868, 83.2185], // Visakhapatnam
  ["std:0866", 16.5062, 80.648], // Vijayawada
  ["std:0731", 22.7196, 75.8577], // Indore
  ["std:0755", 23.2599, 77.4126], // Bhopal
  ["std:0712", 21.1458, 79.0882], // Nagpur
  ["std:0261", 21.1702, 72.8311], // Surat
  ["std:0821", 12.2958, 76.6394], // Mysuru
  ["std:0471", 8.5241, 76.9366], // Thiruvananthapuram
];

export function cityForGps(lat: number, lng: number): string | null {
  const km = (aLat: number, aLng: number) => {
    const rad = Math.PI / 180;
    const dLat = (aLat - lat) * rad;
    const dLng = (aLng - lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(aLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  };
  let best: { code: string; d: number } | null = null;
  for (const [code, cLat, cLng] of CITY_CENTRES) {
    const d = km(cLat, cLng);
    if (d <= 40 && (!best || d < best.d)) best = { code, d };
  }
  return best?.code ?? null;
}

function toStop(p: PlaceInput): Stop {
  return { gps: `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`, address: p.address, area: p.area };
}

/** Asks every ride provider on the network for rides between two points. */
export async function startRideSearch(userId: string, input: { pickup: PlaceInput; drop: PlaceInput; city?: string }, deps: RideDeps = {}) {
  if (!(deps.identity ?? defaultIdentity)()) throw new ApiError(503, "ONDC is not configured on this deployment");
  const city = input.city ? stdCodeFor(input.city) : cityForGps(input.pickup.lat, input.pickup.lng);
  if (!city) throw new ApiError(400, "ONDC rides are not available in this city yet");
  const terms = commercialTerms();
  const pickup = toStop(input.pickup);
  const drop = toStop(input.drop);
  const ride = await prisma.ondcRide.create({
    data: { userId, txnId: crypto.randomUUID(), status: "searching", city, pickup: JSON.stringify(pickup), drop: JSON.stringify(drop) },
  });
  const envelope = buildRideSearch({
    transactionId: ride.txnId,
    city,
    pickup,
    drop,
    finderFeePercent: terms.finderFeePercent,
    staticTermsUrl: terms.staticTermsUrl,
    delayInterestPercent: terms.delayInterestPercent,
  });
  const ok = await sendStep(ride, "search", envelope, null, deps, await searchUrl(userId, "ONDC:TRV10"));
  if (!ok) {
    await prisma.ondcRide.update({ where: { id: ride.id }, data: { status: "failed", problem: PROBLEM.searchRefused } });
  }
  return { rideId: ride.id };
}

/** The rides providers have offered so far, cheapest first. */
export async function rideOffers(userId: string, id: string, now = new Date()) {
  const ride = await ownRide(userId, id);
  const rows = await prisma.ondcTransaction.findMany({
    where: { txnId: ride.txnId, action: "on_search", domain: "ONDC:TRV10" },
    orderBy: { createdAt: "asc" },
    select: { response: true, bppId: true },
  });
  const byKey = new Map<string, RideOffer>();
  for (const row of rows) {
    let offers: RideOffer[] = [];
    try {
      offers = parseRideOnSearch(JSON.parse(row.response ?? "null"));
    } catch {
      offers = [];
    }
    // Only what the verified sender offered as itself.
    for (const o of offers.filter((o) => o.bppId === row.bppId)) byKey.set(`${o.bppId}|${o.providerId}|${o.itemId}`, o);
  }
  // Flouna does not collect fares, so a ride whose provider expects the app
  // to collect it could not be booked on the terms it set, and is not offered.
  const offers = [...byKey.values()].filter((o) => o.collectedBy !== "BAP").sort((a, b) => a.farePaise - b.farePaise);
  const searching = ride.status === "searching" && now.getTime() - ride.createdAt.getTime() < RIDE_SEARCH_WINDOW_MS;
  return { rideId: ride.id, status: searching ? "searching" : "complete", offers };
}

/** Picks one offered ride and asks its provider for the fare. */
export async function chooseRide(userId: string, id: string, pick: { bppId: string; providerId: string; itemId: string }, deps: RideDeps = {}) {
  const ride = await ownRide(userId, id);
  if (!["searching", "quoted"].includes(ride.status)) throw new ApiError(409, `This ride is ${ride.status}, so another ride cannot be chosen`);
  const { offers } = await rideOffers(userId, id);
  const offer = offers.find((o) => o.bppId === pick.bppId && o.providerId === pick.providerId && o.itemId === pick.itemId);
  if (!offer) throw new ApiError(400, "That ride was not offered for this search");
  const claimed = await prisma.ondcRide.updateMany({
    where: { id: ride.id, userId, status: { in: ["searching", "quoted"] } },
    data: {
      bppId: offer.bppId,
      bppUri: offer.bppUri,
      providerId: offer.providerId,
      itemId: offer.itemId,
      fulfillmentId: offer.fulfillmentId,
      vehicle: offer.vehicle,
      farePaise: offer.farePaise,
      quote: null,
      cancellationTerms: null,
      sellerOrderId: null,
      payment: JSON.stringify({ collectedBy: offer.collectedBy ?? "BPP", tags: offer.paymentTags } satisfies RidePaymentTerms),
    },
  });
  if (claimed.count === 0) throw new ApiError(409, "This ride moved on while you were choosing");
  const chosen = await prisma.ondcRide.findUniqueOrThrow({ where: { id: ride.id } });
  const envelope = buildRideSelect(rideBase(chosen));
  await sendStep(chosen, "select", envelope, "selecting", deps, offer.bppUri);
  return { rideId: ride.id };
}

/** When a provider's quote lapses: its ttl from now. Null when it gives none to read. */
function quoteExpiry(quote: unknown, now = new Date()): Date | null {
  const ttl = (quote as { ttl?: unknown } | null | undefined)?.ttl;
  const ms = durationMs(typeof ttl === "string" ? ttl : null);
  return ms === null ? null : new Date(now.getTime() + ms);
}

const lapsed = (r: RideRow, now = new Date()) => r.quoteExpiresAt !== null && r.quoteExpiresAt < now;

function rideBase(r: RideRow) {
  return {
    transactionId: r.txnId,
    city: r.city,
    bpp: { id: r.bppId!, uri: r.bppUri! },
    providerId: r.providerId!,
    itemId: r.itemId!,
    fulfillmentId: r.fulfillmentId!,
    vehicle: r.vehicle as VehicleCategory,
    pickup: stopOf(r.pickup),
    drop: stopOf(r.drop),
  };
}

async function riderOf(r: RideRow) {
  const user = await prisma.user.findUnique({ where: { id: r.userId }, select: { name: true, phone: true } });
  const phone = (user?.phone ?? "").replace(/^\+91/, "").replace(/\D/g, "");
  if (!user || !/^\d{10}$/.test(phone)) throw new ApiError(400, "Add a 10 digit phone number so the driver can reach you");
  return { name: user.name, phone };
}

/**
 * Where providers pay Flouna's finder fee. A ride cannot be booked without it:
 * the provider collects the fare and would have nowhere to send our share.
 */
function settlementParams() {
  const terms = commercialTerms();
  if (!terms.settlement) throw new ApiError(503, "Flouna's account for ride providers' fees is not set up yet");
  return terms.settlementParams;
}

/** Tells the provider who is riding, so it can return its final terms. */
export async function initRide(userId: string, id: string, deps: RideDeps = {}) {
  const ride = await ownRide(userId, id);
  if (ride.status !== "quoted") throw new ApiError(409, `This ride is ${ride.status}, not waiting for your details`);
  const terms = JSON.parse(ride.payment ?? "{}") as RidePaymentTerms;
  if (terms.collectedBy === "BAP") throw new ApiError(409, "This provider wants the app to collect the fare, which Flouna does not do. Choose another ride.");
  // The fare from choosing has lapsed: a fresh one is asked for rather than
  // a stale price carried on. The rider sees it and continues again.
  if (lapsed(ride)) {
    await sendStep(ride, "select", buildRideSelect(rideBase(ride)), "selecting", deps, ride.bppUri!);
    return { rideId: ride.id, refreshed: true };
  }
  const params = settlementParams();
  const customer = await riderOf(ride);
  const envelope = buildRideInit({ ...rideBase(ride), customer, payment: { collectedBy: "BPP", params, tags: terms.tags ?? [] } });
  await sendStep(ride, "init", envelope, "initialising", deps, ride.bppUri!);
  return { rideId: ride.id };
}

/** Books the ride on the terms the provider returned in on_init. */
export async function confirmRide(userId: string, id: string, deps: RideDeps = {}) {
  const ride = await ownRide(userId, id);
  if (ride.status !== "ready") throw new ApiError(409, `This ride is ${ride.status}, not ready to book`);
  const active = await prisma.ondcRide.count({ where: { userId, status: { in: ["booked", "confirming"] }, id: { not: id } } });
  if (active > 0) throw new ApiError(409, "You already have an active ride — cancel it before booking another");
  const terms = JSON.parse(ride.payment ?? "{}") as RidePaymentTerms;
  // The final terms have lapsed: they are fetched again instead of booking a
  // price the provider no longer stands by. The rider confirms the fresh ones.
  if (lapsed(ride)) {
    const refresh = buildRideInit({ ...rideBase(ride), customer: await riderOf(ride), payment: { collectedBy: "BPP", params: settlementParams(), tags: terms.tags ?? [] } });
    await sendStep(ride, "init", refresh, "initialising", deps, ride.bppUri!);
    return { rideId: ride.id, refreshed: true };
  }
  if (!terms.id) throw new ApiError(409, "The provider gave no payment reference to book against");
  const envelope = buildRideConfirm({ ...rideBase(ride), customer: await riderOf(ride), payment: { collectedBy: "BPP", params: settlementParams(), tags: terms.tags, id: terms.id } });
  await sendStep(ride, "confirm", envelope, "confirming", deps, ride.bppUri!);
  return { rideId: ride.id };
}

async function askAboutRide(userId: string, id: string, action: "status" | "track", deps: RideDeps) {
  const ride = await ownRide(userId, id);
  if (!ride.sellerOrderId) throw new ApiError(409, "This ride has not been booked yet");
  const args = { transactionId: ride.txnId, city: ride.city, bpp: { id: ride.bppId!, uri: ride.bppUri! }, orderId: ride.sellerOrderId };
  const envelope = action === "status" ? buildRideStatus(args) : buildRideTrack(args);
  return { asked: await sendStep(ride, action, envelope, null, deps, ride.bppUri!) };
}

export const refreshRide = (userId: string, id: string, deps: RideDeps = {}) => askAboutRide(userId, id, "status", deps);
export const trackRide = (userId: string, id: string, deps: RideDeps = {}) => askAboutRide(userId, id, "track", deps);

/** First step of cancelling: asks what it would cost. Nothing is cancelled yet. */
export async function quoteRideCancel(userId: string, id: string, reasonId: RiderCancelReason, deps: RideDeps = {}) {
  const ride = await ownRide(userId, id);
  if (ride.status !== "booked" || !ride.sellerOrderId) throw new ApiError(409, `This ride is ${ride.status} and cannot be cancelled`);
  if (!(reasonId in RIDER_CANCEL_REASONS)) throw new ApiError(400, "Not a reason a rider can give");
  await prisma.ondcRide.update({ where: { id }, data: { cancelReasonId: reasonId, cancelFeePaise: null } });
  const envelope = buildRideCancel({ transactionId: ride.txnId, city: ride.city, bpp: { id: ride.bppId!, uri: ride.bppUri! }, orderId: ride.sellerOrderId, reasonId, step: "SOFT_CANCEL" });
  await sendStep(ride, "cancel", envelope, "cancel_quoting", deps, ride.bppUri!);
  return { rideId: id };
}

/** Second step: cancels at the fee the rider was shown. */
export async function confirmRideCancel(userId: string, id: string, deps: RideDeps = {}) {
  const ride = await ownRide(userId, id);
  if (ride.status !== "cancel_quoted" || !ride.sellerOrderId || !ride.cancelReasonId) throw new ApiError(409, "Ask what cancelling costs first");
  const envelope = buildRideCancel({ transactionId: ride.txnId, city: ride.city, bpp: { id: ride.bppId!, uri: ride.bppUri! }, orderId: ride.sellerOrderId, reasonId: ride.cancelReasonId, step: "CONFIRM_CANCEL" });
  await sendStep(ride, "cancel", envelope, "cancelling", deps, ride.bppUri!);
  return { rideId: id };
}

/** The rider saw the fee and kept the ride. Nothing was cancelled, so nothing is sent. */
export async function keepRide(userId: string, id: string) {
  const done = await prisma.ondcRide.updateMany({ where: { id, userId, status: "cancel_quoted" }, data: { status: "booked", cancelFeePaise: null } });
  if (done.count === 0) throw new ApiError(409, "This ride is not waiting on a cancellation decision");
}

// ---------------------------------------------------------------------------
// Applying providers' replies

const RIDE_ACTIONS = new Set(["on_select", "on_init", "on_confirm", "on_status", "on_update", "on_cancel"]);

export async function applyRideReply(cb: { action: string; body: Record<string, unknown>; senderId: string }): Promise<"applied" | "ignored"> {
  if (!RIDE_ACTIONS.has(cb.action)) return "ignored";
  const ctx = (cb.body.context ?? {}) as Record<string, unknown>;
  if (ctx.domain !== "ONDC:TRV10" || typeof ctx.transaction_id !== "string") return "ignored";
  const ride = await prisma.ondcRide.findUnique({ where: { txnId: ctx.transaction_id } });
  if (!ride || !ride.bppId || ride.bppId !== cb.senderId) return "ignored";
  const answers = (step: string) => ride.status === step && ctx.message_id === ride.awaitingMsgId;
  const quoteOf = (b: Record<string, unknown>) => (b.message as { order?: { quote?: unknown } }).order?.quote;

  if (cb.action === "on_select") {
    if (!answers("selecting")) return "ignored";
    const r = readRideOnSelect(cb.body);
    await prisma.ondcRide.update({
      where: { id: ride.id },
      data:
        "problem" in r
          ? { status: "searching", problem: r.problem, awaitingMsgId: null }
          : { status: "quoted", quote: JSON.stringify(r.raw), farePaise: r.quote.totalPaise, quoteExpiresAt: quoteExpiry(quoteOf(cb.body)), awaitingMsgId: null },
    });
    return "applied";
  }
  if (cb.action === "on_init") {
    if (!answers("initialising")) return "ignored";
    const r = readRideOnInit(cb.body);
    if ("problem" in r) {
      await prisma.ondcRide.update({ where: { id: ride.id }, data: { status: "quoted", problem: r.problem, awaitingMsgId: null } });
    } else {
      const fareChanged = ride.farePaise != null && r.quote.totalPaise !== ride.farePaise;
      await prisma.ondcRide.update({
        where: { id: ride.id },
        data: {
          status: "ready",
          quote: JSON.stringify(quoteOf(cb.body)),
          farePaise: r.quote.totalPaise,
          payment: JSON.stringify(r.payment),
          cancellationTerms: r.cancellationTerms ? JSON.stringify(r.cancellationTerms) : null,
          quoteExpiresAt: quoteExpiry(quoteOf(cb.body)),
          problem: fareChanged ? fareChangedProblem(ride.farePaise!, r.quote.totalPaise) : null,
          awaitingMsgId: null,
        },
      });
    }
    return "applied";
  }

  const r = readRideState(cb.body);
  if (cb.action === "on_confirm") {
    if (!answers("confirming")) return "ignored";
    if ("problem" in r || !r.orderId || r.status === "CANCELLED") {
      await prisma.ondcRide.update({ where: { id: ride.id }, data: { status: "failed", problem: "problem" in r ? r.problem : PROBLEM.bookingFailed, awaitingMsgId: null } });
      return "applied";
    }
    await prisma.ondcRide.update({ where: { id: ride.id }, data: { status: "booked", sellerOrderId: r.orderId, awaitingMsgId: null, ...stateFields(r) } });
    return "applied";
  }

  if ("problem" in r) {
    // A refused cancellation leaves the ride as it was.
    if (cb.action === "on_cancel" && (answers("cancel_quoting") || answers("cancelling"))) {
      await prisma.ondcRide.update({ where: { id: ride.id }, data: { status: "booked", problem: r.problem, awaitingMsgId: null } });
      return "applied";
    }
    return "ignored";
  }
  if (!ride.sellerOrderId || (r.orderId && r.orderId !== ride.sellerOrderId)) return "ignored";
  if (r.at && ride.sellerUpdatedAt && r.at < ride.sellerUpdatedAt) return "ignored";

  const providerCancelled = r.status === "CANCELLED" || r.rideState === "RIDE_CANCELLED";
  // A fee quote, unless the provider took the first step as final and
  // cancelled outright: then the ride is cancelled, not waiting on the rider.
  if (cb.action === "on_cancel" && answers("cancel_quoting") && !providerCancelled) {
    await prisma.ondcRide.update({
      where: { id: ride.id },
      data: { status: "cancel_quoted", cancelFeePaise: r.quote?.totalPaise ?? null, awaitingMsgId: null, sellerUpdatedAt: r.at ?? ride.sellerUpdatedAt },
    });
    return "applied";
  }
  const status = providerCancelled
    ? "cancelled"
    : r.status === "COMPLETED" || r.rideState === "RIDE_ENDED"
      ? "completed"
      : cb.action === "on_cancel" && answers("cancelling")
        ? "booked"
        : ride.status;
  await prisma.ondcRide.update({
    where: { id: ride.id },
    data: {
      status,
      ...((answers("cancelling") || answers("cancel_quoting")) && cb.action === "on_cancel" && status === "booked" ? { problem: PROBLEM.rideCancelRefused } : {}),
      ...(cb.action === "on_cancel" ? { awaitingMsgId: null } : {}),
      ...stateFields(r),
    },
  });
  return "applied";
}

function stateFields(r: Exclude<ReturnType<typeof readRideState>, { problem: string }>) {
  return {
    ...(r.status ? { orderStatus: r.status } : {}),
    ...(r.rideState ? { rideState: r.rideState } : {}),
    ...(r.driver ? { driver: JSON.stringify(r.driver) } : {}),
    ...(r.vehicle ? { vehicleInfo: JSON.stringify(r.vehicle) } : {}),
    ...(r.startOtp ? { startOtp: r.startOtp } : {}),
    ...(r.quote ? { farePaise: r.quote.totalPaise, quote: JSON.stringify(r.rawQuote) } : {}),
    ...(r.at ? { sellerUpdatedAt: r.at } : {}),
  };
}

// ---------------------------------------------------------------------------
// What the app shows

export async function rideView(userId: string, id: string) {
  const r = await ownRide(userId, id);
  const track = r.sellerOrderId
    ? await prisma.ondcTransaction.findFirst({ where: { txnId: r.txnId, action: "on_track", bppId: r.bppId }, orderBy: { createdAt: "desc" }, select: { response: true } })
    : null;
  let tracking: ReturnType<typeof readRideTrack> = null;
  try {
    tracking = track?.response ? readRideTrack(JSON.parse(track.response)) : null;
  } catch {
    tracking = null;
  }
  return {
    id: r.id,
    status: r.status,
    problem: r.problem,
    problemCode: problemCode(r.problem),
    pickup: stopOf(r.pickup),
    drop: stopOf(r.drop),
    vehicle: r.vehicle,
    farePaise: r.farePaise,
    cancelFeePaise: r.cancelFeePaise,
    rideState: r.rideState,
    driver: r.driver ? (JSON.parse(r.driver) as { name?: string; phone?: string }) : null,
    vehicleInfo: r.vehicleInfo ? (JSON.parse(r.vehicleInfo) as Record<string, string>) : null,
    // The rider gives this to the driver at pickup; shown only while it is useful.
    startOtp: r.status === "booked" && r.rideState !== "RIDE_STARTED" ? r.startOtp : null,
    tracking,
    createdAt: r.createdAt.toISOString(),
  };
}
