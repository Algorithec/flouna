import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { BAP_ID, checkedHttpsUrl } from "./context.js";
import { durationMs, finderFeePaise } from "./ondcMoney.js";
import type { PaymentTerms } from "./orderReplies.js";
import {
  buildOnRecon,
  buildRecon,
  buildReport,
  buildSettle,
  buildSettleNil,
  compareFigures,
  readRecon,
  readSettlementResult,
  type OnReconOrder,
  type Party,
  type ReconFigures,
  type ReconStatus,
} from "./settlement.js";
import type { SigningIdentity } from "./signing.js";
import { sendSigned, type SendResult } from "./transport.js";

// The settlement ledger: one row per completed ONDC order, saying who owes
// whom what for it and where the money has got to.
//
// Nothing here moves money by itself. A person sends the settlement agency
// its instructions (instructSettlements), and the agency moves the money and
// answers. When Flouna collected, the order's seller payout is also recorded
// for paying by hand (ondcMoney.ts): a seller must never be paid both ways,
// so sending an instruction first claims that payout (status "via_rsf"), and
// a payout already paid or claimed keeps its order out of the instruction.

/**
 * Sends a signed message. `url` is the participant's base URI: sendSigned
 * appends the action itself, so passing ".../settle" would post to
 * ".../settle/settle".
 */
type Send = (url: string, action: string, envelope: { context: Record<string, unknown>; message?: unknown; error?: unknown }, id: SigningIdentity) => Promise<SendResult>;
export type SettlementDeps = { send?: Send; identity?: () => SigningIdentity | null; now?: () => Date };

const DAY = 86_400_000;
const BATCH = 100;

function defaultIdentity(): SigningIdentity | null {
  return env.ONDC_SUBSCRIBER_ID && env.ONDC_UNIQUE_KEY_ID && env.ONDC_SIGNING_PRIVATE_KEY
    ? { subscriberId: env.ONDC_SUBSCRIBER_ID, uniqueKeyId: env.ONDC_UNIQUE_KEY_ID, signingPrivateKey: env.ONDC_SIGNING_PRIVATE_KEY }
    : null;
}

/**
 * The settlement agency, from configuration, or null if none is set. Both
 * values come from the agency's onboarding (NBBL's NOCS for ONDC); without
 * them nothing can be settled, though reconciliation with sellers still works.
 */
export function settlementAgency(e: Record<string, string | undefined> = process.env): Party | null {
  const id = e.ONDC_SETTLEMENT_AGENCY_ID?.trim();
  const url = e.ONDC_SETTLEMENT_AGENCY_URL?.trim();
  if (!id && !url) return null;
  if (!id || !url) throw new Error("ONDC_SETTLEMENT_AGENCY_ID and ONDC_SETTLEMENT_AGENCY_URL are set together");
  return { id, uri: checkedHttpsUrl(url, "ONDC_SETTLEMENT_AGENCY_URL") };
}

/**
 * Records what is to be settled for an order the seller has completed. Once
 * per order. Amounts come from the seller's own terms in on_init:
 *
 *   - The seller collected (the usual case): we are the receiver. The seller
 *     owes us the Buyer Finder Fee, which is the whole of what moves.
 *   - Flouna collected: we are the collector. We owe the seller the order
 *     total less our fee, and keep the fee.
 *
 * Anything a person should look at first starts "held": every order Flouna
 * collected for (seller payouts stay off until Cashfree confirms the
 * arrangement in writing, per Gnana's decision of 22 October 2026), a seller
 * asking for money to be withheld, and settlement after a return window the
 * order does not carry.
 */
export async function recordSettlement(ondcOrderId: string, completedAt: Date) {
  const order = await prisma.ondcOrder.findUnique({ where: { id: ondcOrderId } });
  if (!order || !order.payment || order.totalPaise == null || !order.sellerOrderId) return;
  const terms = JSON.parse(order.payment) as PaymentTerms;
  const role = terms.collectedBy === "BAP" ? "collector" : "receiver";
  // Flouna can only settle money it actually took.
  if (role === "collector" && !order.paidAt) return;

  const total = order.totalPaise;
  const fee = finderFeePaise(total, terms);
  const withholding = terms.withholdingPaise ?? 0;
  const held: string[] = [];
  if (role === "collector") {
    held.push("Flouna collected this order. Seller payouts stay off until Cashfree confirms the arrangement in writing; release it once that is done.");
  }
  if (terms.settlementBasis === "return_window_expiry") held.push("It settles after the seller's return window, which the order does not carry: check it first.");
  if (withholding > 0) held.push(`The seller asked for ${withholding / 100} rupees to be withheld: check how it is released.`);

  const amounts =
    role === "collector"
      ? { interParticipantPaise: Math.max(total - fee - withholding, 0), collectorPaise: fee + withholding, selfPaise: fee }
      : { interParticipantPaise: fee, collectorPaise: total - fee, selfPaise: fee };
  if (role === "collector" && total - fee - withholding < 0) held.push("The fee and withholding come to more than the order: check the seller's terms.");

  const windowMs = durationMs(terms.settlementWindow) ?? 3 * DAY;
  await prisma.ondcSettlement
    .create({
      data: {
        ondcOrderId: order.id,
        bppId: order.bppId,
        networkOrderId: order.sellerOrderId,
        role,
        orderTotalPaise: total,
        feePaise: fee,
        withholdingPaise: withholding,
        ...amounts,
        settlementBasis: terms.settlementBasis ?? null,
        settlementWindow: terms.settlementWindow ?? null,
        dueAt: new Date(completedAt.getTime() + windowMs),
        status: held.length ? "held" : "due",
        note: held.length ? held.join(" ") : null,
      },
    })
    .catch((err: { code?: string }) => {
      // Already recorded: the seller sent Completed again.
      if (err.code !== "P2002") throw err;
    });
}

/** A person has checked a held settlement and lets it go into the next instruction. */
export async function releaseSettlement(id: string) {
  const done = await prisma.ondcSettlement.updateMany({ where: { id, status: "held" }, data: { status: "due" } });
  return done.count === 1;
}

export function listSettlements(status?: string) {
  return prisma.ondcSettlement.findMany({
    where: status ? { status } : {},
    orderBy: [{ status: "asc" }, { dueAt: "asc" }],
    take: 500,
  });
}

async function logOutbound(envelope: { context: Record<string, unknown> }, action: string, bppId: string, ack: boolean) {
  await prisma.ondcTransaction.create({
    data: {
      txnId: String(envelope.context.transaction_id),
      messageId: String(envelope.context.message_id),
      action,
      domain: "ONDC:NTS10",
      bppId,
      request: JSON.stringify(envelope),
      status: ack ? "ack" : "nack",
      signed: true,
      simulated: false,
    },
  });
}

async function sendTo(baseUri: string, action: string, envelope: { context: Record<string, unknown>; message?: unknown; error?: unknown }, deps: SettlementDeps) {
  const id = (deps.identity ?? defaultIdentity)();
  if (!id) throw new ApiError(503, "ONDC is not configured on this deployment");
  try {
    return await (deps.send ?? ((u, a, e, i) => sendSigned(u, a, e as { context: Record<string, unknown>; message: unknown }, i)))(baseUri, action, envelope, id);
  } catch (err) {
    return { ack: false, status: 0, error: err instanceof Error ? err.message : String(err) } as SendResult;
  }
}

/**
 * Sends the settlement agency instructions for the due settlements with one
 * seller app, in one role. Each row is claimed before anything is sent, so
 * two people pressing the button at once cannot instruct an order twice; if
 * the agency does not acknowledge, the claims are let go again.
 */
export async function instructSettlements(o: { bppId: string; role: "receiver" | "collector"; ids?: string[] }, deps: SettlementDeps = {}) {
  const agency = settlementAgency();
  if (!agency) throw new ApiError(503, "No settlement agency is configured (ONDC_SETTLEMENT_AGENCY_ID and ONDC_SETTLEMENT_AGENCY_URL)");
  // Checked before anything is claimed: an instruction that cannot be signed
  // must not leave orders looking sent, or a seller's payout locked.
  if (!(deps.identity ?? defaultIdentity)()) throw new ApiError(503, "ONDC is not configured on this deployment");
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await prisma.ondcSettlement.findMany({
    where: { bppId: o.bppId, role: o.role, status: "due", dueAt: { lte: now }, ...(o.ids ? { id: { in: o.ids } } : {}) },
    orderBy: { dueAt: "asc" },
    take: BATCH,
  });
  if (candidates.length === 0) throw new ApiError(409, "Nothing is due to settle with this seller app");

  const settlementId = crypto.randomUUID();
  const transactionId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const claimed: typeof candidates = [];
  // Each claimed payout's state before the claim, to put back exactly.
  const payoutsBefore = new Map<string, { status: string; note: string | null }>();
  const skipped: { id: string; reason: string }[] = [];

  const letGo = async () => {
    await prisma.ondcSettlement.updateMany({
      where: { id: { in: claimed.map((r) => r.id) }, status: "instructed", settlementId },
      data: { status: "due", settlementId: null, settleTxnId: null, settleMsgId: null, instructedAt: null },
    });
    for (const [ondcOrderId, before] of payoutsBefore) {
      await prisma.ondcPayout.updateMany({ where: { ondcOrderId, status: "via_rsf" }, data: before });
    }
  };

  for (const row of candidates) {
    if (row.role === "collector") {
      // Paid through the agency, so never also by hand: the payout is claimed
      // first, and a payout already paid or claimed keeps the order out.
      const payout = await prisma.ondcPayout.findUnique({ where: { ondcOrderId: row.ondcOrderId } });
      const waiting = payout && (payout.status === "due" || payout.status === "held");
      const got = waiting
        ? await prisma.ondcPayout.updateMany({
            where: { id: payout.id, status: payout.status },
            data: { status: "via_rsf", note: `Paid through ONDC settlement ${settlementId}` },
          })
        : { count: 0 };
      if (got.count !== 1) {
        await prisma.ondcSettlement.updateMany({
          where: { id: row.id, status: "due" },
          data: { status: "held", note: "Its seller payout is not waiting to be paid (already paid by hand, or missing): check before settling" },
        });
        skipped.push({ id: row.id, reason: "payout not waiting" });
        continue;
      }
      payoutsBefore.set(row.ondcOrderId, { status: payout!.status, note: payout!.note });
    }
    const got = await prisma.ondcSettlement.updateMany({
      where: { id: row.id, status: "due" },
      data: { status: "instructed", settlementId, settleTxnId: transactionId, settleMsgId: messageId, instructedAt: now },
    });
    if (got.count === 1) claimed.push(row);
    else if (payoutsBefore.has(row.ondcOrderId)) {
      const before = payoutsBefore.get(row.ondcOrderId)!;
      payoutsBefore.delete(row.ondcOrderId);
      await prisma.ondcPayout.updateMany({ where: { ondcOrderId: row.ondcOrderId, status: "via_rsf" }, data: before });
    }
  }
  if (claimed.length === 0) throw new ApiError(409, "Nothing was left to settle once checked");

  // From here, anything short of the agency's acknowledgement lets every
  // claim go again, whatever the reason.
  let acked = false;
  try {
    const envelope = buildSettle({
      agency,
      collectorAppId: o.role === "collector" ? BAP_ID : o.bppId,
      receiverAppId: o.role === "collector" ? o.bppId : BAP_ID,
      settlementId,
      transactionId,
      messageId,
      now,
      orders: claimed.map((r) => ({
        networkOrderId: r.networkOrderId,
        interParticipantPaise: r.interParticipantPaise,
        collectorPaise: r.collectorPaise,
        selfPaise: r.selfPaise,
      })),
    });
    const result = await sendTo(agency.uri, "settle", envelope, deps);
    acked = result.ack;
    // A log that cannot be written must not undo an instruction the agency
    // has accepted.
    await logOutbound(envelope, "settle", agency.id, result.ack).catch((err) =>
      console.error("[ondc] could not log a settlement instruction", err instanceof Error ? err.message : String(err)),
    );
  } finally {
    if (!acked) await letGo();
  }
  if (!acked) throw new ApiError(502, "The settlement agency did not accept the instruction. Nothing was sent; try again.");
  return { settlementId, transactionId, orders: claimed.length, skipped };
}

/** Tells the settlement agency we have nothing to settle as a collector this cycle. */
export async function declareNilSettlement(deps: SettlementDeps = {}) {
  const agency = settlementAgency();
  if (!agency) throw new ApiError(503, "No settlement agency is configured (ONDC_SETTLEMENT_AGENCY_ID and ONDC_SETTLEMENT_AGENCY_URL)");
  // Not nothing, if we hold collected money that is due to a seller.
  const owing = await prisma.ondcSettlement.count({ where: { role: "collector", status: { in: ["due", "held"] } } });
  if (owing > 0) throw new ApiError(409, `There are ${owing} settlements Flouna owes sellers, so this cycle is not nil`);
  const envelope = buildSettleNil({ agency, settlementId: crypto.randomUUID(), now: (deps.now ?? (() => new Date()))() });
  const result = await sendTo(agency.uri, "settle", envelope, deps);
  await logOutbound(envelope, "settle", agency.id, result.ack);
  if (!result.ack) throw new ApiError(502, "The settlement agency did not accept the declaration; try again");
  return { settlementId: envelope.message.settlement.id };
}

/** Asks the settlement agency where an instruction has got to. Its answer (on_report) is applied like on_settle. */
export async function requestSettlementReport(settlementId: string, deps: SettlementDeps = {}) {
  const agency = settlementAgency();
  if (!agency) throw new ApiError(503, "No settlement agency is configured (ONDC_SETTLEMENT_AGENCY_ID and ONDC_SETTLEMENT_AGENCY_URL)");
  const row = await prisma.ondcSettlement.findFirst({ where: { settlementId, settleTxnId: { not: null } } });
  if (!row?.settleTxnId || !row.settleMsgId) throw new ApiError(404, "No instruction with that settlement id was sent");
  const envelope = buildReport({ agency, refTransactionId: row.settleTxnId, refMessageId: row.settleMsgId, now: (deps.now ?? (() => new Date()))() });
  const result = await sendTo(agency.uri, "report", envelope, deps);
  await logOutbound(envelope, "report", agency.id, result.ack);
  if (!result.ack) throw new ApiError(502, "The settlement agency did not accept the request; try again");
  return { requested: true };
}

type Row = NonNullable<Awaited<ReturnType<typeof prisma.ondcSettlement.findUnique>>>;

function reconStatusOf(row: Row): ReconStatus {
  if (row.status === "settled") return "SETTLED";
  if (row.status === "instructed") return "PENDING";
  return "TO_BE_INITIATED";
}

async function ourFigures(row: Row): Promise<ReconFigures> {
  const order = await prisma.ondcOrder.findUnique({ where: { id: row.ondcOrderId }, select: { paymentRef: true } });
  return {
    networkOrderId: row.networkOrderId,
    orderTotalPaise: row.orderTotalPaise,
    settlementId: row.settlementId ?? row.id,
    // The payment's own reference when Flouna took it; otherwise the seller
    // took it and the order id is what both sides share.
    paymentId: order?.paymentRef ?? row.networkOrderId,
    status: reconStatusOf(row),
    amountPaise: row.interParticipantPaise,
    commissionPaise: row.feePaise,
    withholdingPaise: row.withholdingPaise,
    tcsPaise: row.tcsPaise,
    tdsPaise: row.tdsPaise,
    referenceNo: row.referenceNo ?? undefined,
    updatedAt: row.updatedAt,
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Sends a seller app our figures for some of its orders, to reconcile. */
export async function sendRecon(ids: string[], deps: SettlementDeps = {}) {
  if (ids.length === 0 || ids.length > BATCH) throw new ApiError(400, `Reconcile between 1 and ${BATCH} orders at a time`);
  const rows = await prisma.ondcSettlement.findMany({ where: { id: { in: ids } } });
  if (rows.length !== ids.length) throw new ApiError(404, "Some of those settlements do not exist");
  const bppIds = new Set(rows.map((r) => r.bppId));
  if (bppIds.size !== 1) throw new ApiError(400, "Reconcile with one seller app at a time");
  const order = await prisma.ondcOrder.findUnique({ where: { id: rows[0]!.ondcOrderId }, select: { bppUri: true } });
  if (!order) throw new ApiError(404, "The order behind that settlement no longer exists");
  const bpp = { id: rows[0]!.bppId, uri: order.bppUri };
  const envelope = buildRecon({ bpp, orders: await Promise.all(rows.map(ourFigures)), now: (deps.now ?? (() => new Date()))() });
  const result = await sendTo(bpp.uri, "recon", envelope, deps);
  await logOutbound(envelope, "recon", bpp.id, result.ack);
  if (!result.ack) throw new ApiError(502, "The seller app did not accept the reconciliation; try again");
  await prisma.ondcSettlement.updateMany({
    where: { id: { in: ids } },
    data: { reconStatus: "sent", reconTxnId: String(envelope.context.transaction_id), reconAt: new Date() },
  });
  return { sent: rows.length };
}

const NTS_ACTIONS = new Set(["on_settle", "on_report", "recon", "on_recon"]);

/**
 * Applies a verified settlement message: the agency's answer to an
 * instruction (on_settle, on_report), or a seller app reconciling with us
 * (recon, which we answer, and on_recon). Anything from anyone else, or about
 * orders that are not with the sender, changes nothing.
 */
export async function applySettlementMessage(
  cb: { action: string; body: Record<string, unknown>; senderId: string },
  deps: SettlementDeps = {},
): Promise<"applied" | "ignored"> {
  if (!NTS_ACTIONS.has(cb.action)) return "ignored";
  const ctx = (cb.body.context ?? {}) as Record<string, unknown>;
  if (ctx.domain !== "ONDC:NTS10") return "ignored";

  if (cb.action === "on_settle" || cb.action === "on_report") {
    const agency = settlementAgency();
    if (!agency || cb.senderId !== agency.id) return "ignored";
    const r = readSettlementResult(cb.body);
    if ("problem" in r) {
      // The whole instruction was refused (a duplicate id, an unknown app).
      // Only an on_settle names the instruction by its transaction.
      if (cb.action !== "on_settle") return "ignored";
      const rows = await prisma.ondcSettlement.findMany({ where: { settleTxnId: String(ctx.transaction_id), status: "instructed" } });
      for (const row of rows) await markNotSettled(row, r.problem);
      return rows.length ? "applied" : "ignored";
    }
    if (!r.settlementId) return "ignored";
    let changed = 0;
    for (const o of r.orders) {
      const row = await prisma.ondcSettlement.findFirst({ where: { settlementId: r.settlementId, networkOrderId: o.networkOrderId } });
      // An on_settle is about the instruction it answers; on_report may also
      // bring a later answer for one that had failed.
      if (!row || !(row.status === "instructed" || (cb.action === "on_report" && row.status === "not_settled"))) continue;
      if (cb.action === "on_settle" && row.settleTxnId !== ctx.transaction_id) continue;
      if (o.status === "SETTLED") {
        await prisma.ondcSettlement.update({
          where: { id: row.id },
          data: { status: "settled", settledPaise: o.settledPaise, referenceNo: o.referenceNo ?? null, settledAt: new Date(), errorCode: null, errorMessage: null },
        });
        if (row.role === "collector" && row.status === "not_settled") await settledAfterFailure(row, o.referenceNo);
        changed++;
      } else if (o.status === "NOT_SETTLED") {
        await markNotSettled(row, o.error ?? "The settlement agency did not settle it");
        changed++;
      }
    }
    return changed ? "applied" : "ignored";
  }

  // recon / on_recon: between us and the seller app the orders are with.
  const r = readRecon(cb.body);
  if (cb.action === "on_recon") {
    if ("problem" in r) {
      await prisma.ondcSettlement.updateMany({
        where: { bppId: cb.senderId, reconTxnId: String(ctx.transaction_id) },
        data: { reconStatus: "dispute", note: `The seller app answered our reconciliation with an error: ${r.problem}` },
      });
      return "applied";
    }
    let changed = 0;
    for (const theirs of r.orders) {
      const row = await prisma.ondcSettlement.findFirst({ where: { bppId: cb.senderId, networkOrderId: theirs.networkOrderId } });
      if (!row) continue;
      await prisma.ondcSettlement.update({
        where: { id: row.id },
        data: { reconStatus: theirs.accord ? "accord" : "dispute", counterpartyView: JSON.stringify(theirs), reconAt: new Date() },
      });
      changed++;
    }
    return changed ? "applied" : "ignored";
  }

  // A recon from the seller app: compare, record, and answer with on_recon.
  const bppOrder = await prisma.ondcOrder.findFirst({ where: { bppId: cb.senderId }, select: { bppUri: true } });
  if (!bppOrder) return "ignored";
  const bpp = { id: cb.senderId, uri: bppOrder.bppUri };
  const reply = async (answer: Parameters<typeof buildOnRecon>[0]["answer"]) => {
    const envelope = buildOnRecon({ bpp, transactionId: String(ctx.transaction_id), messageId: String(ctx.message_id), answer, now: (deps.now ?? (() => new Date()))() });
    const result = await sendTo(bpp.uri, "on_recon", envelope, deps);
    await logOutbound(envelope, "on_recon", bpp.id, result.ack);
  };
  if ("problem" in r) {
    await reply({ error: { code: "70002", message: r.problem } });
    return "applied";
  }
  const rows: Row[] = [];
  const unknown: string[] = [];
  for (const theirs of r.orders) {
    const row = await prisma.ondcSettlement.findFirst({ where: { bppId: cb.senderId, networkOrderId: theirs.networkOrderId } });
    if (row) rows.push(row);
    else unknown.push(theirs.networkOrderId);
  }
  if (unknown.length) {
    await reply({ error: { code: "70030", message: `Invalid Order Id: ${unknown.join(", ")}` } });
    return "applied";
  }
  const answers: OnReconOrder[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const theirs = r.orders[i]!;
    const ours = await ourFigures(row);
    const cmp = compareFigures(ours, theirs);
    answers.push({ ...ours, accord: cmp.agree, diffs: cmp.diffs, dueDate: ymd(row.dueAt) });
    await prisma.ondcSettlement.update({
      where: { id: row.id },
      data: { reconStatus: cmp.agree ? "accord" : "dispute", counterpartyView: JSON.stringify(theirs), reconTxnId: String(ctx.transaction_id), reconAt: new Date() },
    });
  }
  await reply({ orders: answers });
  return "applied";
}

/**
 * The agency settled an order it had reported as not settled. Its payout went
 * back to a person in between: it is claimed again so nobody pays it by hand,
 * and if somebody already has, the seller has been paid twice, which is said
 * loudly on both rows so the money can be recovered.
 */
async function settledAfterFailure(row: Row, referenceNo?: string) {
  const reclaimed = await prisma.ondcPayout.updateMany({
    where: { ondcOrderId: row.ondcOrderId, status: "held" },
    data: { status: "via_rsf", note: `Paid through ONDC settlement ${row.settlementId} (reference ${referenceNo ?? "none"})` },
  });
  if (reclaimed.count === 1) return;
  const payout = await prisma.ondcPayout.findUnique({ where: { ondcOrderId: row.ondcOrderId } });
  if (payout?.status === "paid") {
    const warning = `PAID TWICE: the settlement agency settled this order (reference ${referenceNo ?? "none"}) after it was paid by hand (UTR ${payout.utr ?? "unknown"}). Recover one payment from the seller.`;
    await prisma.ondcSettlement.update({ where: { id: row.id }, data: { note: warning } });
    await prisma.ondcPayout.update({ where: { id: payout.id }, data: { note: warning } });
    console.error("[ondc] seller paid twice for order", row.ondcOrderId);
  }
}

async function markNotSettled(row: Row, error: string) {
  const [code, ...rest] = error.split(": ");
  await prisma.ondcSettlement.update({
    where: { id: row.id },
    data: {
      status: "not_settled",
      errorCode: rest.length ? code : null,
      errorMessage: rest.length ? rest.join(": ") : error,
    },
  });
  // The seller is still owed. Its payout goes back to a person, who checks
  // the agency's answer before paying it any other way.
  if (row.role === "collector") {
    await prisma.ondcPayout.updateMany({
      where: { ondcOrderId: row.ondcOrderId, status: "via_rsf" },
      data: { status: "held", note: `ONDC settlement failed (${error}); check with the settlement agency before paying by hand` },
    });
  }
}
