import crypto from "node:crypto";
import { buildContext } from "./context.js";
import { paiseOf } from "./orderReplies.js";
import { rupees } from "./retail.js";

// Settlement and reconciliation messages (ONDC RSF 2.0.0, domain ONDC:NTS10).
//
// Settlement goes through a settlement agency (NBBL's NOCS), not from one app
// to the other. For each order, whoever collected the customer's money (the
// collector) and the other app (the receiver) both send the agency matching
// instructions: what moves from collector to receiver (inter_participant),
// what the collector keeps (collector), and what the sender wants moved to its
// own operating account (self). The agency compares the two and answers each
// with on_settle. Reconciliation (recon, on_recon) is between the two apps,
// about the same orders, whenever their figures disagree.
//
// Modelled on ONDC-NTS-Specifications (release-RSF-2.0.0) and held to the
// RSF_v2 schemas of ONDC's log validation utility. Amounts are integer paise
// here and rupee strings with two decimals on the wire.

const DOMAIN = "ONDC:NTS10" as const;

export type Party = { id: string; uri: string };

const money = (paise: number) => ({ currency: "INR", value: rupees(paise) });

function checkPaise(label: string, paise: number) {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error(`${label} is not an amount in paise: ${paise}`);
}

export type SettleOrder = {
  /** The order id on the network: the seller app's, from on_confirm. */
  networkOrderId: string;
  interParticipantPaise: number;
  collectorPaise: number;
  selfPaise: number;
};

/** Settlement instructions for orders with one counterparty, sent to the settlement agency. */
export function buildSettle(o: {
  agency: Party;
  collectorAppId: string;
  receiverAppId: string;
  settlementId: string;
  orders: SettleOrder[];
  transactionId?: string;
  /** Ours to choose; the agency's on_settle repeats it. */
  messageId?: string;
  now?: Date;
}) {
  if (o.orders.length === 0) throw new Error("A settlement instruction needs at least one order");
  if (new Set(o.orders.map((x) => x.networkOrderId)).size !== o.orders.length) throw new Error("An order appears twice in one settlement instruction");
  for (const x of o.orders) {
    if (!x.networkOrderId) throw new Error("An order in a settlement instruction has no network order id");
    checkPaise("Inter participant amount", x.interParticipantPaise);
    checkPaise("Collector amount", x.collectorPaise);
    checkPaise("Self amount", x.selfPaise);
  }
  return {
    context: buildContext({
      domain: DOMAIN,
      action: "settle",
      city: "*",
      transactionId: o.transactionId ?? crypto.randomUUID(),
      messageId: o.messageId,
      bppId: o.agency.id,
      bppUri: o.agency.uri,
      ttl: "P1D",
      now: o.now,
    }),
    message: {
      collector_app_id: o.collectorAppId,
      receiver_app_id: o.receiverAppId,
      settlement: {
        type: "NP-NP",
        id: o.settlementId,
        orders: o.orders.map((x) => ({
          id: x.networkOrderId,
          inter_participant: { amount: money(x.interParticipantPaise) },
          collector: { amount: money(x.collectorPaise) },
          self: { amount: money(x.selfPaise) },
        })),
      },
    },
  };
}

/**
 * Declares that we have nothing to settle as a collector this cycle. The
 * specification only requires the type; ONDC's validator also asks for an id
 * and an order list, so both are sent (the list empty).
 */
export function buildSettleNil(o: { agency: Party; settlementId: string; transactionId?: string; now?: Date }) {
  return {
    context: buildContext({
      domain: DOMAIN,
      action: "settle",
      city: "*",
      transactionId: o.transactionId ?? crypto.randomUUID(),
      bppId: o.agency.id,
      bppUri: o.agency.uri,
      ttl: "P1D",
      now: o.now,
    }),
    message: { settlement: { type: "NIL", id: o.settlementId, orders: [] } },
  };
}

/** Asks the settlement agency where an instruction we sent has got to. */
export function buildReport(o: { agency: Party; refTransactionId: string; refMessageId: string; transactionId?: string; now?: Date }) {
  return {
    context: buildContext({
      domain: DOMAIN,
      action: "report",
      city: "*",
      transactionId: o.transactionId ?? crypto.randomUUID(),
      bppId: o.agency.id,
      bppUri: o.agency.uri,
      ttl: "P1D",
      now: o.now,
    }),
    message: { ref_transaction_id: o.refTransactionId, ref_message_id: o.refMessageId },
  };
}

export const RECON_STATUSES = ["PENDING", "SETTLED", "TO_BE_INITIATED"] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

/** Our figures for one order, as reconciliation states them. */
export type ReconFigures = {
  networkOrderId: string;
  orderTotalPaise: number;
  settlementId: string;
  paymentId: string;
  status: ReconStatus;
  amountPaise: number;
  commissionPaise: number;
  withholdingPaise: number;
  tcsPaise: number;
  tdsPaise: number;
  referenceNo?: string;
  updatedAt: Date;
};

const FIELDS = ["amount", "commission", "withholding_amount", "tcs", "tds"] as const;
type Field = (typeof FIELDS)[number];
const paiseOfField = (f: ReconFigures, field: Field) =>
  field === "amount" ? f.amountPaise : field === "commission" ? f.commissionPaise : field === "withholding_amount" ? f.withholdingPaise : field === "tcs" ? f.tcsPaise : f.tdsPaise;

function reconSettlement(f: ReconFigures, extra: { diffs?: Partial<Record<Field, number>>; dueDate?: string } = {}) {
  for (const field of FIELDS) checkPaise(field, paiseOfField(f, field));
  const amount = (field: Field) => {
    const diff = extra.diffs?.[field];
    return { ...money(paiseOfField(f, field)), ...(diff ? { diff_value: rupees(diff) } : {}) };
  };
  return {
    id: f.settlementId,
    payment_id: f.paymentId,
    status: f.status,
    ...(extra.dueDate ? { due_date: extra.dueDate } : {}),
    amount: amount("amount"),
    commission: amount("commission"),
    withholding_amount: amount("withholding_amount"),
    tcs: amount("tcs"),
    tds: amount("tds"),
    ...(f.referenceNo ? { settlement_ref_no: f.referenceNo } : {}),
    updated_at: f.updatedAt.toISOString(),
  };
}

/**
 * Our figures for orders with one seller app, for it to reconcile. The
 * context carries the same buyer and seller apps as the orders themselves,
 * whichever side sends it.
 */
export function buildRecon(o: { bpp: Party; orders: ReconFigures[]; transactionId?: string; now?: Date }) {
  if (o.orders.length === 0) throw new Error("A reconciliation needs at least one order");
  return {
    context: buildContext({
      domain: DOMAIN,
      action: "recon",
      city: "*",
      transactionId: o.transactionId ?? crypto.randomUUID(),
      bppId: o.bpp.id,
      bppUri: o.bpp.uri,
      ttl: "P1D",
      now: o.now,
    }),
    message: {
      orders: o.orders.map((f) => {
        checkPaise("Order total", f.orderTotalPaise);
        return { id: f.networkOrderId, amount: money(f.orderTotalPaise), settlements: [reconSettlement(f)] };
      }),
    },
  };
}

export type OnReconOrder = ReconFigures & { accord: boolean; diffs?: Partial<Record<Field, number>>; dueDate?: string };

/**
 * Our answer to a seller app's reconciliation: our own figures for each
 * order, whether we agree, the difference where we do not, and the date it
 * settles where we do. An answer about orders we do not know is an error.
 */
export function buildOnRecon(o: {
  bpp: Party;
  transactionId: string;
  messageId: string;
  answer: { orders: OnReconOrder[] } | { error: { code: string; message: string } };
  now?: Date;
}) {
  const context = buildContext({
    domain: DOMAIN,
    action: "on_recon",
    city: "*",
    transactionId: o.transactionId,
    messageId: o.messageId,
    bppId: o.bpp.id,
    bppUri: o.bpp.uri,
    ttl: "P1D",
    now: o.now,
  });
  if ("error" in o.answer) return { context, error: o.answer.error };
  return {
    context,
    message: {
      orders: o.answer.orders.map((f) => ({
        id: f.networkOrderId,
        amount: money(f.orderTotalPaise),
        recon_accord: f.accord,
        settlements: [reconSettlement(f, { diffs: f.diffs, dueDate: f.accord ? f.dueDate : undefined })],
      })),
    },
  };
}

// ---- Reading what comes back -----------------------------------------------

type Wire = Record<string, unknown>;
const obj = (v: unknown): Wire => (v && typeof v === "object" && !Array.isArray(v) ? (v as Wire) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const amountOf = (v: unknown) => paiseOf(obj(v).value);

function errorOf(body: unknown): string | null {
  const e = obj(obj(body).error);
  const code = str(e.code) ?? (typeof e.code === "number" ? String(e.code) : undefined);
  const message = str(e.message);
  if (!code && !message) return null;
  return [code, message].filter(Boolean).join(": ");
}

export type SettledOrder = {
  networkOrderId: string;
  status: "SETTLED" | "NOT_SETTLED" | null;
  settledPaise: number | null;
  referenceNo?: string;
  error?: string;
};

/** on_settle or on_report: what the agency did with each order of an instruction. */
export function readSettlementResult(body: unknown): { settlementId?: string; type?: string; orders: SettledOrder[] } | { problem: string } {
  const problem = errorOf(body);
  const settlement = obj(obj(obj(body).message).settlement);
  const orders = arr(settlement.orders).map(obj);
  if (problem && orders.length === 0) return { problem };
  return {
    settlementId: str(settlement.id),
    type: str(settlement.type),
    orders: orders
      .map((o): SettledOrder | null => {
        const id = str(o.id);
        if (!id) return null;
        const inter = obj(o.inter_participant);
        const status = str(inter.status);
        const e = obj(inter.error);
        return {
          networkOrderId: id,
          status: status === "SETTLED" || status === "NOT_SETTLED" ? status : null,
          settledPaise: amountOf(inter.settled_amount),
          referenceNo: str(inter.reference_no),
          ...(str(e.code) || str(e.message) ? { error: [str(e.code), str(e.message)].filter(Boolean).join(": ") } : {}),
        };
      })
      .filter((o): o is SettledOrder => o !== null),
  };
}

export type TheirFigures = {
  networkOrderId: string;
  orderTotalPaise: number | null;
  accord?: boolean;
  amountPaise: number | null;
  commissionPaise: number | null;
  withholdingPaise: number | null;
  tcsPaise: number | null;
  tdsPaise: number | null;
  status?: string;
  referenceNo?: string;
};

/** recon or on_recon from the seller app: its figures for each order. */
export function readRecon(body: unknown): { orders: TheirFigures[] } | { problem: string } {
  const problem = errorOf(body);
  const orders = arr(obj(obj(body).message).orders).map(obj);
  if (problem && orders.length === 0) return { problem };
  const out: TheirFigures[] = [];
  for (const o of orders) {
    const id = str(o.id);
    if (!id) return { problem: "An order in the reconciliation has no id" };
    // One settlement per order is all retail does today; the first is read.
    const s = obj(arr(o.settlements)[0]);
    out.push({
      networkOrderId: id,
      orderTotalPaise: amountOf(o.amount),
      ...(typeof o.recon_accord === "boolean" ? { accord: o.recon_accord } : {}),
      amountPaise: amountOf(s.amount),
      commissionPaise: amountOf(s.commission),
      withholdingPaise: amountOf(s.withholding_amount),
      tcsPaise: amountOf(s.tcs),
      tdsPaise: amountOf(s.tds),
      status: str(s.status),
      referenceNo: str(s.settlement_ref_no),
    });
  }
  if (out.length === 0) return { problem: "The reconciliation names no orders" };
  return { orders: out };
}

/**
 * Field by field, where their figures differ from ours. `diffs` holds the
 * difference in paise for figures both sides stated; a figure they left out
 * or sent unreadably is listed in `unreadable` instead, since there is no true
 * difference to state for it. Either one means we do not agree. So does a
 * different order total, which the protocol gives no difference field for.
 */
export function compareFigures(ours: ReconFigures, theirs: TheirFigures): { agree: boolean; diffs: Partial<Record<Field, number>>; unreadable: Field[] } {
  const pairs: [Field, number, number | null][] = [
    ["amount", ours.amountPaise, theirs.amountPaise],
    ["commission", ours.commissionPaise, theirs.commissionPaise],
    ["withholding_amount", ours.withholdingPaise, theirs.withholdingPaise],
    ["tcs", ours.tcsPaise, theirs.tcsPaise],
    ["tds", ours.tdsPaise, theirs.tdsPaise],
  ];
  const diffs: Partial<Record<Field, number>> = {};
  const unreadable: Field[] = [];
  for (const [field, a, b] of pairs) {
    if (b === null) unreadable.push(field);
    else if (a !== b) diffs[field] = Math.abs(a - b);
  }
  const sameTotal = theirs.orderTotalPaise === ours.orderTotalPaise;
  return { agree: sameTotal && unreadable.length === 0 && Object.keys(diffs).length === 0, diffs, unreadable };
}
