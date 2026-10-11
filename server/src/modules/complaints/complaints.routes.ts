import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import {
  createComplaint,
  listComplaints,
  getComplaint,
  provideInformation,
  decideResolution,
  escalateComplaint,
} from "./complaints.service.js";
import { addEvidence, readEvidence } from "./evidence.service.js";

// Customer-facing complaint API (ONDC IGM 2.0).
//
// Everything here is the buyer app talking to its own backend. The app never
// touches ONDC endpoints or carries network credentials — the guide is explicit
// about that, and it is also why the protocol adapter lives server-side.
export const complaintsRouter = Router();
complaintsRouter.use(requireAuth);

// Category and sub-category are ONDC-controlled vocabularies. They are accepted
// as bounded strings and validated against the live spec in the adapter rather
// than being enumerated here — the guide warns against inventing enum values,
// and a wrong list baked into the API boundary would reject valid complaints.
const CATEGORY = z.string().trim().min(2).max(64);

complaintsRouter.post(
  "/",
  validateBody(
    z.object({
      orderId: z.string().cuid().optional(),
      fulfillmentId: z.string().trim().max(64).optional(),
      itemIds: z.array(z.string().trim().max(64)).max(50).optional(),
      category: CATEGORY,
      subCategory: CATEGORY.optional(),
      description: z.string().trim().min(5).max(2000),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const complaint = await createComplaint({
        userId: req.userId!,
        ...(req.body as {
          orderId?: string;
          fulfillmentId?: string;
          itemIds?: string[];
          category: string;
          subCategory?: string;
          description: string;
        }),
      });
      res.status(201).json({ complaint });
    } catch (err) {
      next(err);
    }
  },
);

complaintsRouter.get("/", async (req, res, next) => {
  try {
    res.json({ complaints: await listComplaints(req.userId!) });
  } catch (err) {
    next(err);
  }
});

complaintsRouter.get("/:id", async (req, res, next) => {
  try {
    res.json({ complaint: await getComplaint(req.userId!, req.params.id!) });
  } catch (err) {
    next(err);
  }
});

// The customer-safe action trail. Protocol messages are never included.
complaintsRouter.get("/:id/timeline", async (req, res, next) => {
  try {
    const complaint = await getComplaint(req.userId!, req.params.id!);
    res.json({
      status: complaint.status,
      timeline: complaint.actions.map((a) => ({
        code: a.code,
        description: a.description,
        at: a.createdAt,
        by: a.actionBy,
      })),
    });
  } catch (err) {
    next(err);
  }
});

complaintsRouter.post(
  "/:id/information",
  validateBody(z.object({ message: z.string().trim().min(2).max(2000) }).strict()),
  async (req, res, next) => {
    try {
      const { message } = req.body as { message: string };
      res.json(await provideInformation(req.userId!, req.params.id!, message));
    } catch (err) {
      next(err);
    }
  },
);

complaintsRouter.post("/:id/resolution/:resolutionId/accept", async (req, res, next) => {
  try {
    res.json(
      await decideResolution(
        req.userId!,
        req.params.id!,
        req.params.resolutionId!,
        "accepted",
      ),
    );
  } catch (err) {
    next(err);
  }
});

complaintsRouter.post("/:id/resolution/:resolutionId/reject", async (req, res, next) => {
  try {
    res.json(
      await decideResolution(
        req.userId!,
        req.params.id!,
        req.params.resolutionId!,
        "rejected",
      ),
    );
  } catch (err) {
    next(err);
  }
});

complaintsRouter.post(
  "/:id/escalate",
  validateBody(
    z
      .object({
        reason: z.string().trim().min(5).max(500),
        // The level the customer saw when they tapped. Optional so an older
        // app still works, which then gets the weaker check below.
        fromLevel: z.number().int().min(0).max(1).optional(),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const { reason, fromLevel } = req.body as { reason: string; fromLevel?: number };
      res.json(await escalateComplaint(req.userId!, req.params.id!, reason, fromLevel));
    } catch (err) {
      next(err);
    }
  },
);

// Evidence.
//
// The global body limit is 100kb, which is right for the rest of the API and
// far too small for a photo. The larger limit cannot be granted from here: the
// app-level parser runs before routing and had already refused the body, so the
// 8mb parser that used to sit on this line never saw a request and every photo
// came back "That request was too large". It is granted in app.ts, beside the
// ceiling it is an exception to, which is the only place it can take effect.
// 8mb of JSON accommodates the 5mb file cap plus base64's overhead.
complaintsRouter.post(
  "/:id/evidence",
  validateBody(z.object({ dataUrl: z.string().min(32).max(8_000_000) }).strict()),
  async (req, res, next) => {
    try {
      const { dataUrl } = req.body as { dataUrl: string };
      const evidence = await addEvidence({
        userId: req.userId!,
        complaintId: req.params.id!,
        dataUrl,
      });
      res.status(201).json({ evidence });
    } catch (err) {
      next(err);
    }
  },
);

// Bytes come back only here, behind auth and an ownership check. There is no
// static path to the upload directory.
complaintsRouter.get("/:id/evidence/:evidenceId", async (req, res, next) => {
  try {
    const { bytes, mimeType } = await readEvidence(
      req.userId!,
      req.params.evidenceId!,
    );
    res.setHeader("Content-Type", mimeType);
    // Never render an upload inline in the app's own origin.
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(bytes);
  } catch (err) {
    next(err);
  }
});

// Refund status, read from the refund records rather than inferred from the
// complaint state. An accepted resolution is a promise; this reports money.
complaintsRouter.get("/:id/refund", async (req, res, next) => {
  try {
    const complaint = await getComplaint(req.userId!, req.params.id!);
    res.json({
      refunds: complaint.refunds.map((r) => ({
        amountPaise: r.amountPaise,
        status: r.status,
        reference: r.refundReference,
        initiatedAt: r.initiatedAt,
        completedAt: r.completedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});
