// Admin (operations) console API. Scoped to the `admin` role — and super_admin
// satisfies it via the hierarchy. Read models for users/orders/analytics plus a
// small set of audited, money-safe mutations (suspend a user, flag a refund,
// work the support queue). No secrets, no role changes (that's super-admin only).

import { Router, type Request } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { listTermsAcceptances } from "../ondc/termsAcceptance.js";
import { commissionCsv, commissionReport, decideException, EXCEPTION_REASONS } from "../ondc/commission.service.js";
import {
  listComplaintsForOps,
  getComplaintForOps,
  simulateSellerAcknowledgement,
  simulateInformationRequest,
  simulateResolutionProposal,
  simulateRefundCompleted,
} from "../complaints/complaints.admin.js";
import {
  assignOfficer,
  concludeGrievance,
  decideAppeal,
  grievanceQueue,
  openAppeal,
  recordContact,
} from "../complaints/grievance.ops.js";
import {
  answerAppeal,
  listAppealsForOps,
} from "../compliance/appeals.service.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { auditFromReq } from "./audit.service.js";
import { markPayoutPaid, payoutsDue, refundsNeedingAttention, resolveRefund } from "../ondc/ondcMoney.js";
import {
  declareNilSettlement,
  instructSettlements,
  listSettlements,
  releaseSettlement,
  requestSettlementReport,
  sendRecon,
} from "../ondc/settlement.service.js";
import {
  searchUsers,
  getUserDetail,
  setUserSuspended,
  listOrders,
  flagRefund,
  adminAnalytics,
} from "./admin.service.js";
import {
  listTickets,
  getTicket,
  updateTicket,
  TICKET_STATUSES,
  TICKET_PRIORITIES,
} from "./tickets.service.js";
import {
  dashboardSummary,
  cityReport,
  vendorReport,
  decisionLogs,
  rankingDecisions,
  couponStats,
  priceAlertsOverview,
  gmvByDomain,
  adminTrends,
  systemHealth,
  CITY_SORTS,
  dashboardCsv,
  analyticsCsv,
  citiesCsv,
  vendorsCsv,
  trendsCsv,
} from "./reporting.service.js";

// A page number out of a URL, parsed rather than coerced. `Number(...) || 1`
// let "1e400" through as Infinity, which reached Prisma as a skip it refuses:
// the console answered 500 to a query string, and in a non-production
// environment the body carried the query and the server's own file path with
// it. A fractional page was worse than wrong — it was quietly accepted and
// skipped a fraction of a row, so page 1.5 reported an empty list while page 1
// had results.
const pageParam = z.coerce.number().int().min(1).max(100_000).catch(1);

export const adminRouter = Router();
adminRouter.use(requireRole("admin")); // super_admin satisfies admin

// Filters for the city report, applied on the server so an export holds the
// rows the page shows. An unknown state or tier is simply nothing to show.
const cityQuery = z.object({
  state: z.string().trim().max(60).optional().catch(undefined),
  tier: z.string().trim().max(20).optional().catch(undefined),
  sort: z.enum(CITY_SORTS).catch("orders"),
});

// Days for a trend, parsed the way pageParam is: a query string never reaches
// a query as Infinity or a fraction.
const daysParam = z.coerce.number().int().min(7).max(90).catch(30);

adminRouter.get("/reports/trends", async (req, res, next) => {
  try {
    res.json(await adminTrends(daysParam.parse(req.query.days)));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/system-health", async (_req, res, next) => {
  try {
    res.json(await systemHealth());
  } catch (err) {
    next(err);
  }
});

// --- Report exports: CSV that opens in Excel. Audited, as every data pull from
// the console is, and never cached on the way.
const REPORT_EXPORTS: Record<string, (req: Request) => Promise<string>> = {
  dashboard: () => dashboardCsv(),
  analytics: () => analyticsCsv(),
  cities: (req) => citiesCsv(cityQuery.parse(req.query)),
  vendors: () => vendorsCsv(),
  trends: (req) => trendsCsv(daysParam.parse(req.query.days)),
};

for (const [name, build] of Object.entries(REPORT_EXPORTS)) {
  adminRouter.get(`/reports/${name}.csv`, async (req, res, next) => {
    try {
      const csv = await build(req);
      await auditFromReq(req, { action: `export.${name}`, targetType: "system", summary: `Exported the ${name} report` });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
      res.setHeader("Cache-Control", "no-store");
      // The byte order mark tells Excel the file is UTF-8, so a city or vendor
      // name outside ASCII opens as written.
      res.send(`\uFEFF${csv}`);
    } catch (err) {
      next(err);
    }
  });
}

// --- Reporting dashboards (founder's admin view) ------------------------
adminRouter.get("/dashboard", async (_req, res, next) => {
  try {
    res.json(await dashboardSummary());
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/reports/gmv-by-domain", async (_req, res, next) => {
  try {
    res.json({ domains: await gmvByDomain() });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/cities", async (req, res, next) => {
  try {
    res.json(await cityReport(cityQuery.parse(req.query)));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/vendors", async (_req, res, next) => {
  try {
    res.json(await vendorReport());
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/decisions", async (_req, res, next) => {
  try {
    res.json(await decisionLogs(50));
  } catch (err) {
    next(err);
  }
});

// Why a recommendation ranked the way it did — the record behind the answer we
// give ONDC on ranking auditability. Distinct from /decisions above, which
// reports what users asked for rather than how the engine chose.
adminRouter.get("/ranking-decisions", async (_req, res, next) => {
  try {
    res.json(await rankingDecisions(50));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/coupons", async (_req, res, next) => {
  try {
    res.json(await couponStats());
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/price-alerts", async (_req, res, next) => {
  try {
    res.json(await priceAlertsOverview());
  } catch (err) {
    next(err);
  }
});

// --- Analytics -----------------------------------------------------------
adminRouter.get("/analytics", async (_req, res, next) => {
  try {
    res.json(await adminAnalytics());
  } catch (err) {
    next(err);
  }
});

// --- Users ---------------------------------------------------------------
adminRouter.get("/users", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const page = pageParam.parse(req.query.page);
    res.json(await searchUsers({ q, page }));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/users/:id", async (req, res, next) => {
  try {
    const detail = await getUserDetail(req.params.id!);
    if (!detail) return res.status(404).json({ error: "Not found" });
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch(
  "/users/:id/suspend",
  validateBody(z.object({ suspended: z.boolean() }).strict()),
  async (req, res, next) => {
    try {
      const { suspended } = req.body as { suspended: boolean };
      const result = await setUserSuspended(req.params.id!, suspended);
      if (!result.ok) {
        // Don't let an admin suspend a fellow operator from here.
        const code = result.reason === "not_found" ? 404 : 403;
        return res.status(code).json({ error: result.reason });
      }
      await auditFromReq(req, {
        action: suspended ? "user.suspend" : "user.reinstate",
        targetType: "user",
        targetId: req.params.id!,
        summary: `${suspended ? "Suspended" : "Reinstated"} user ${req.params.id}`,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// --- Orders --------------------------------------------------------------
adminRouter.get("/orders", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
    const page = pageParam.parse(req.query.page);
    res.json(await listOrders({ status, domain, page }));
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/orders/:id/flag-refund", async (req, res, next) => {
  try {
    const result = await flagRefund(req.params.id!);
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : 409;
      return res.status(code).json({ error: result.reason });
    }
    await auditFromReq(req, {
      action: "order.flag_refund",
      targetType: "order",
      targetId: req.params.id!,
      summary: `Flagged refund for "${result.title}"`,
      metadata: { userId: result.userId },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- ONDC money: payouts to seller apps, refunds needing a person ---------
// Recording a payout moves no money: the operator has already sent the
// transfer from the bank and records its reference here, once.
adminRouter.get("/ondc/payouts", async (_req, res, next) => {
  try {
    res.json({ payouts: await payoutsDue() });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/ondc/payouts/:id/paid",
  validateBody(z.object({ utr: z.string().trim().min(6).max(40).regex(/^[A-Za-z0-9]+$/) }).strict()),
  async (req, res, next) => {
    try {
      if (!(await markPayoutPaid(req.params.id!, req.userId!, req.body.utr))) return res.status(409).json({ error: "This payout is not waiting to be paid" });
      await auditFromReq(req, { action: "ondc.payout_paid", targetType: "ondc_payout", targetId: req.params.id!, summary: `Recorded ONDC payout as paid (UTR ${req.body.utr})` });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// --- ONDC settlement (RSF): instructions to the settlement agency ------------
// See ondc/settlement.service.ts. Nothing moves money until a person sends
// an instruction, and every one is audited.
const SETTLEMENT_STATUSES = ["held", "due", "instructed", "settled", "not_settled"] as const;

adminRouter.get("/ondc/settlements", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" && (SETTLEMENT_STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : undefined;
    res.json({ settlements: await listSettlements(status) });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/ondc/settlements/:id/release", async (req, res, next) => {
  try {
    if (!(await releaseSettlement(req.params.id!))) return res.status(409).json({ error: "This settlement is not held" });
    await auditFromReq(req, { action: "ondc.settlement_released", targetType: "ondc_settlement", targetId: req.params.id!, summary: "Released a held ONDC settlement" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/ondc/settlements/instruct",
  validateBody(
    z
      .object({
        bppId: z.string().trim().min(3).max(200),
        role: z.enum(["receiver", "collector"]),
        ids: z.array(z.string().cuid()).min(1).max(100).optional(),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const result = await instructSettlements(req.body as { bppId: string; role: "receiver" | "collector"; ids?: string[] });
      await auditFromReq(req, {
        action: "ondc.settlement_instructed",
        targetType: "ondc_settlement",
        targetId: result.settlementId,
        summary: `Sent the settlement agency instructions for ${result.orders} orders with ${req.body.bppId} (${req.body.role})`,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post("/ondc/settlements/nil", async (req, res, next) => {
  try {
    const result = await declareNilSettlement();
    await auditFromReq(req, { action: "ondc.settlement_nil", targetType: "ondc_settlement", targetId: result.settlementId, summary: "Declared a nil settlement cycle to the settlement agency" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/ondc/settlements/report",
  validateBody(z.object({ settlementId: z.string().uuid() }).strict()),
  async (req, res, next) => {
    try {
      res.json(await requestSettlementReport(req.body.settlementId));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  "/ondc/settlements/recon",
  validateBody(z.object({ ids: z.array(z.string().cuid()).min(1).max(100) }).strict()),
  async (req, res, next) => {
    try {
      const result = await sendRecon(req.body.ids);
      await auditFromReq(req, { action: "ondc.recon_sent", targetType: "ondc_settlement", targetId: req.body.ids[0], summary: `Sent a seller app our figures for ${result.sent} orders to reconcile` });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// --- Commission on ONDC orders, and settlements that do not add up ---
//
// A period is whole days, from and to inclusive, in YYYY-MM-DD. Without one,
// the last 30 days. Anything else is refused rather than guessed at.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodQuery = z
  .object({ from: day.optional(), to: day.optional() })
  .transform(({ from, to }) => {
    const end = to ? new Date(`${to}T00:00:00.000Z`) : new Date();
    const until = new Date(end.getTime() + (to ? 86_400_000 : 0));
    const since = from ? new Date(`${from}T00:00:00.000Z`) : new Date(until.getTime() - 30 * 86_400_000);
    return { from: since, to: until };
  })
  .refine((p) => !Number.isNaN(p.from.getTime()) && !Number.isNaN(p.to.getTime()) && p.from < p.to, "Choose a start date before the end date");

adminRouter.get("/ondc/commission", async (req, res, next) => {
  try {
    const period = periodQuery.safeParse(req.query);
    if (!period.success) return res.status(400).json({ error: "Choose a valid period" });
    res.json(await commissionReport(period.data));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/ondc/commission.csv", async (req, res, next) => {
  try {
    const period = periodQuery.safeParse(req.query);
    if (!period.success) return res.status(400).json({ error: "Choose a valid period" });
    const name = `ondc-commission-${period.data.from.toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(await commissionCsv(period.data));
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/ondc/commission/exceptions",
  validateBody(
    z
      .object({
        settlementId: z.string().cuid(),
        reason: z.enum(EXCEPTION_REASONS),
        status: z.enum(["investigating", "resolved"]),
        note: z.string().trim().max(500).optional(),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const body = req.body as { settlementId: string; reason: (typeof EXCEPTION_REASONS)[number]; status: "investigating" | "resolved"; note?: string };
      if (!(await decideException({ ...body, by: req.userId! }))) {
        return res.status(409).json({ error: "This settlement is not in the queue for that reason" });
      }
      await auditFromReq(req, {
        action: "ondc.settlement_exception",
        targetType: "ondc_settlement",
        targetId: body.settlementId,
        summary: `Marked a settlement ${body.reason.replace(/_/g, " ")} as ${body.status}`,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get("/ondc/refunds", async (_req, res, next) => {
  try {
    res.json({ refunds: await refundsNeedingAttention() });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/ondc/orders/:id/refund",
  validateBody(z.union([z.object({ paise: z.number().int().min(0) }).strict(), z.object({ retry: z.literal(true) }).strict()])),
  async (req, res, next) => {
    try {
      if (!(await resolveRefund(req.params.id!, req.body))) return res.status(409).json({ error: "This refund cannot be changed that way" });
      await auditFromReq(req, {
        action: "ondc.refund_resolved",
        targetType: "ondc_order",
        targetId: req.params.id!,
        summary: "retry" in req.body ? "Retried a failed ONDC refund" : `Set ONDC refund to ${req.body.paise} paise`,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// --- ONDC: which version of our static terms each seller app accepted ------
// The record static terms 17.6.1 asks us to keep (see ondc/termsAcceptance.ts).
adminRouter.get("/ondc/terms-acceptances", async (_req, res, next) => {
  try {
    res.json({ acceptances: await listTermsAcceptances() });
  } catch (err) {
    next(err);
  }
});

// --- Support tickets -----------------------------------------------------
adminRouter.get("/tickets", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const page = pageParam.parse(req.query.page);
    res.json(await listTickets({ status, page }));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/tickets/:id", async (req, res, next) => {
  try {
    const ticket = await getTicket(req.params.id!);
    if (!ticket) return res.status(404).json({ error: "Not found" });
    res.json({ ticket });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch(
  "/tickets/:id",
  validateBody(
    z.object({
      status: z.enum(TICKET_STATUSES).optional(),
      priority: z.enum(TICKET_PRIORITIES).optional(),
      resolution: z.string().max(2000).optional(),
      assignToMe: z.boolean().optional(),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const body = req.body as {
        status?: string;
        priority?: string;
        resolution?: string;
        assignToMe?: boolean;
      };
      const updated = await updateTicket(req.params.id!, {
        status: body.status,
        priority: body.priority,
        resolution: body.resolution,
        ...(body.assignToMe ? { assigneeId: req.userId! } : {}),
      });
      if (!updated) return res.status(404).json({ error: "Not found" });
      await auditFromReq(req, {
        action: "ticket.update",
        targetType: "ticket",
        targetId: req.params.id!,
        summary: `Updated ticket ${req.params.id}${body.status ? ` → ${body.status}` : ""}`,
        metadata: body,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- ONDC IGM complaints (operator view) ----------
//
// The live walkthrough asks us to show the backend record and the ONDC message
// log beside the customer's screen, so the verifier can connect the two.

// --- The grievance queue -------------------------------------------------
//
// The complaint routes above are about the ONDC protocol. These are about the
// promises we published to the customer: assigned in 48 hours, contacted in 5
// days, concluded in 30, an appeal decided in 15. Until now the console could
// simulate a seller acknowledgement but could not do any of those four, so the
// clocks ran with nobody able to stop them.

adminRouter.get("/grievances", async (req, res, next) => {
  try {
    const includeSettled = req.query.all === "1";
    res.json({ grievances: await grievanceQueue({ includeSettled }) });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/grievances/:id/assign",
  validateBody(z.object({ officerId: z.string().trim().min(1).max(120) }).strict()),
  async (req, res, next) => {
    try {
      const { officerId } = req.body as { officerId: string };
      const grievance = await assignOfficer(req.params.id!, officerId);
      await auditFromReq(req, {
        action: "grievance.assign",
        targetType: "complaint",
        targetId: req.params.id!,
        summary: `Assigned grievance officer ${officerId}`,
      });
      res.json({ grievance });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post("/grievances/:id/contacted", async (req, res, next) => {
  try {
    const grievance = await recordContact(req.params.id!);
    await auditFromReq(req, {
      action: "grievance.contacted",
      targetType: "complaint",
      targetId: req.params.id!,
      summary: "Recorded first contact with the customer",
    });
    res.json({ grievance });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/grievances/:id/conclude",
  validateBody(z.object({ outcome: z.string().trim().min(5).max(4000) }).strict()),
  async (req, res, next) => {
    try {
      const { outcome } = req.body as { outcome: string };
      const grievance = await concludeGrievance(req.params.id!, outcome);
      await auditFromReq(req, {
        action: "grievance.conclude",
        targetType: "complaint",
        targetId: req.params.id!,
        summary: "Concluded the grievance investigation",
      });
      res.json({ grievance });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post("/grievances/:id/appeal", async (req, res, next) => {
  try {
    const grievance = await openAppeal(req.params.id!);
    await auditFromReq(req, {
      action: "grievance.appeal.open",
      targetType: "complaint",
      targetId: req.params.id!,
      summary: "Opened the customer's internal appeal",
    });
    res.json({ grievance });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/grievances/:id/appeal/decide",
  validateBody(z.object({ outcome: z.string().trim().min(5).max(4000) }).strict()),
  async (req, res, next) => {
    try {
      const { outcome } = req.body as { outcome: string };
      const grievance = await decideAppeal(req.params.id!, outcome);
      await auditFromReq(req, {
        action: "grievance.appeal.decide",
        targetType: "complaint",
        targetId: req.params.id!,
        summary: "Decided the internal appeal",
      });
      res.json({ grievance });
    } catch (err) {
      next(err);
    }
  },
);

// --- Challenges to a decision the engine made ----------------------------

adminRouter.get("/appeals", async (req, res, next) => {
  try {
    res.json({ appeals: await listAppealsForOps({ openOnly: req.query.all !== "1" }) });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/appeals/:id/answer",
  validateBody(z.object({ response: z.string().trim().min(5).max(4000) }).strict()),
  async (req, res, next) => {
    try {
      const { response } = req.body as { response: string };
      // The reviewer is whoever is signed in, taken from the session rather
      // than from the request body. A person may require that a human looked
      // at an automated decision, and a name the caller could type is not
      // evidence that one did.
      const result = await answerAppeal({
        appealId: req.params.id!,
        reviewerId: req.userId!,
        response,
      });
      if (!result.ok) {
        throw new ApiError(result.reason === "not_found" ? 404 : 400, "Could not answer that appeal");
      }
      await auditFromReq(req, {
        action: "appeal.answer",
        targetType: "decision_appeal",
        targetId: req.params.id!,
        summary: "Answered a challenge to a recommendation",
      });
      res.json(result.appeal);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get("/complaints", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json({ complaints: await listComplaintsForOps({ status }) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/complaints/:id", async (req, res, next) => {
  try {
    res.json({ complaint: await getComplaintForOps(req.params.id!) });
  } catch (err) {
    next(err);
  }
});

// Seller-side rehearsal. Refused in production — see complaints.admin.ts.
adminRouter.post("/complaints/:id/simulate/:step", async (req, res, next) => {
  try {
    const id = req.params.id!;
    switch (req.params.step) {
      case "acknowledge":
        res.json(await simulateSellerAcknowledgement(id));
        return;
      case "request-info":
        res.json(
          await simulateInformationRequest(
            id,
            typeof req.body?.message === "string"
              ? req.body.message
              : "Please share a photo of what you received",
          ),
        );
        return;
      case "propose":
        res.json(
          await simulateResolutionProposal(id, [
            { type: "REFUND", amountPaise: 35000, description: "Full refund" },
            { type: "REPLACEMENT", description: "Send a replacement" },
          ]),
        );
        return;
      case "complete-refund":
        res.json(await simulateRefundCompleted(id, `RFND-${Date.now()}`));
        return;
      default:
        res.status(400).json({ error: "Unknown simulation step" });
    }
  } catch (err) {
    next(err);
  }
});
