import type { OndcSettlement } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

// Our commission on ONDC orders, and the settlements that do not add up.
//
// The ONDC half of the Payment, Commission & Settlement Tracking spec. Every
// number is worked out from the settlement rows (settlement.service.ts), so
// commission is never stored twice and cannot drift from what was settled:
//
//   expected     the Buyer Finder Fee on every completed order
//   confirmed    of that, what the seller app agreed in reconciliation
//   received     what actually reached us, once the settlement is done
//   outstanding  expected not yet received
//   variance     settled amount less the amount due, where they differ
//
// Which side collected decides what "received" means. When the seller app
// collected, it pays us the fee and the settled amount is what we got. When
// Flouna collected, we keep the fee and pay the seller the rest, so paying the
// seller more or less than due changes what we kept by the same amount.

const DAY_MS = 86_400_000;
/** An instruction still unsettled a day after its due date is overdue. */
export const OVERDUE_AFTER_MS = DAY_MS;
/** A held row nobody has released in a week needs someone to look. */
export const HELD_TOO_LONG_MS = 7 * DAY_MS;

export const EXCEPTION_REASONS = ["amount_mismatch", "dispute", "failed", "overdue", "held_too_long"] as const;
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];

/** What reached us for one order, once it is settled; null before. */
export function receivedPaise(r: OndcSettlement): number | null {
  if (r.status !== "settled" || r.settledPaise == null) return null;
  return r.role === "receiver" ? r.settledPaise : r.feePaise + (r.interParticipantPaise - r.settledPaise);
}

/** Settled amount less the amount due; null until settled. */
export function variancePaise(r: OndcSettlement): number | null {
  return r.status === "settled" && r.settledPaise != null ? r.settledPaise - r.interParticipantPaise : null;
}

/** Why a row is in the exception queue, if it is. */
export function exceptionReasons(r: OndcSettlement, now: Date): ExceptionReason[] {
  const out: ExceptionReason[] = [];
  const v = variancePaise(r);
  if (v != null && v !== 0) out.push("amount_mismatch");
  if (r.reconStatus === "dispute") out.push("dispute");
  if (r.status === "not_settled") out.push("failed");
  if ((r.status === "due" || r.status === "instructed") && now.getTime() - r.dueAt.getTime() > OVERDUE_AFTER_MS) {
    out.push("overdue");
  }
  if (r.status === "held" && now.getTime() - r.createdAt.getTime() > HELD_TOO_LONG_MS) out.push("held_too_long");
  return out;
}

type Totals = {
  orders: number;
  orderValuePaise: number;
  expectedPaise: number;
  confirmedPaise: number;
  receivedPaise: number;
  outstandingPaise: number;
  variancePaise: number;
};

function emptyTotals(): Totals {
  return { orders: 0, orderValuePaise: 0, expectedPaise: 0, confirmedPaise: 0, receivedPaise: 0, outstandingPaise: 0, variancePaise: 0 };
}

function add(t: Totals, r: OndcSettlement) {
  const got = receivedPaise(r);
  t.orders++;
  t.orderValuePaise += r.orderTotalPaise;
  t.expectedPaise += r.feePaise;
  if (r.reconStatus === "accord") t.confirmedPaise += r.feePaise;
  t.receivedPaise += got ?? 0;
  t.outstandingPaise += Math.max(r.feePaise - (got ?? 0), 0);
  t.variancePaise += variancePaise(r) ?? 0;
}

/** Settlement rows for orders completed in [from, to), newest first. */
function rowsBetween(from: Date, to: Date) {
  return prisma.ondcSettlement.findMany({
    where: { createdAt: { gte: from, lt: to } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
}

export async function commissionReport(opts: { from: Date; to: Date; now?: Date }) {
  const now = opts.now ?? new Date();
  const rows = await rowsBetween(opts.from, opts.to);
  const totals = emptyTotals();
  const byApp = new Map<string, Totals>();
  for (const r of rows) {
    add(totals, r);
    const t = byApp.get(r.bppId) ?? emptyTotals();
    add(t, r);
    byApp.set(r.bppId, t);
  }

  const flagged = rows.flatMap((r) => exceptionReasons(r, now).map((reason) => ({ row: r, reason })));
  const decisions = flagged.length
    ? await prisma.settlementException.findMany({ where: { settlementId: { in: [...new Set(flagged.map((f) => f.row.id))] } } })
    : [];
  const decided = new Map(decisions.map((d) => [`${d.settlementId}:${d.reason}`, d]));

  return {
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    totals,
    bySellerApp: [...byApp.entries()]
      .map(([bppId, t]) => ({ bppId, ...t }))
      .sort((a, b) => b.expectedPaise - a.expectedPaise),
    exceptions: flagged.map(({ row, reason }) => {
      const d = decided.get(`${row.id}:${reason}`);
      return {
        settlementId: row.id,
        reason,
        status: d?.status ?? "open",
        note: d?.note ?? null,
        bppId: row.bppId,
        networkOrderId: row.networkOrderId,
        role: row.role,
        settlementStatus: row.status,
        dueAt: row.dueAt.toISOString(),
        feePaise: row.feePaise,
        duePaise: row.interParticipantPaise,
        settledPaise: row.settledPaise,
        variancePaise: variancePaise(row),
        errorMessage: row.errorMessage,
      };
    }),
  };
}

/**
 * A person's decision about one exception. Refused unless the row is in the
 * queue for that reason right now, so nothing can be filed against a row that
 * adds up.
 */
export async function decideException(input: {
  settlementId: string;
  reason: ExceptionReason;
  status: "investigating" | "resolved";
  note?: string;
  by: string;
  now?: Date;
}): Promise<boolean> {
  const row = await prisma.ondcSettlement.findUnique({ where: { id: input.settlementId } });
  if (!row || !exceptionReasons(row, input.now ?? new Date()).includes(input.reason)) return false;
  await prisma.settlementException.upsert({
    where: { settlementId_reason: { settlementId: input.settlementId, reason: input.reason } },
    create: { settlementId: input.settlementId, reason: input.reason, status: input.status, note: input.note ?? null, updatedBy: input.by },
    update: { status: input.status, note: input.note ?? null, updatedBy: input.by },
  });
  return true;
}

/**
 * A cell as Excel should read it. Seller apps choose their own ids and send
 * error text, and a cell starting with = + - or @ is run as a formula when
 * the file is opened, so those are prefixed with an apostrophe.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Every settlement row in the period, with what it means for our commission. Amounts in rupees. */
export async function commissionCsv(opts: { from: Date; to: Date; now?: Date }): Promise<string> {
  const now = opts.now ?? new Date();
  const rows = await rowsBetween(opts.from, opts.to);
  const rupees = (p: number | null) => (p == null ? null : (p / 100).toFixed(2));
  const head = [
    "completed", "seller_app", "network_order_id", "collected_by", "order_total", "commission_expected",
    "commission_confirmed", "commission_received", "amount_due", "amount_settled", "variance",
    "settlement_status", "due", "settled", "reference", "reconciliation", "exceptions",
  ];
  const lines = rows.map((r) =>
    [
      r.createdAt.toISOString().slice(0, 10),
      r.bppId,
      r.networkOrderId,
      r.role === "receiver" ? "seller app" : "Flouna",
      rupees(r.orderTotalPaise),
      rupees(r.feePaise),
      r.reconStatus === "accord" ? rupees(r.feePaise) : null,
      rupees(receivedPaise(r)),
      rupees(r.interParticipantPaise),
      rupees(r.settledPaise),
      rupees(variancePaise(r)),
      r.status,
      r.dueAt.toISOString().slice(0, 10),
      r.settledAt ? r.settledAt.toISOString().slice(0, 10) : null,
      r.referenceNo,
      r.reconStatus,
      exceptionReasons(r, now).join(" "),
    ].map(csvCell).join(","),
  );
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
