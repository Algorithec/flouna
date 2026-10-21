import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env, isProd } from "../../config/env.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { BUYER_CANCEL_REASONS, type BuyerCancelReason } from "./retail.js";
import { ondcSearchFor } from "./search.service.js";
import { startOndcPayment, verifyOndcPayment } from "./ondcPay.service.js";
import {
  cancelOndcOrder,
  confirmOndcOrder,
  initOndcOrder,
  markOndcOrderPaid,
  ondcOrderView,
  refreshOndcOrder,
  startOndcOrder,
  trackOndcOrder,
} from "./orders.service.js";

// The customer's food orders with ONDC sellers. Each step answers at once and
// the seller's reply arrives over the next seconds, so the app polls GET /:id
// and moves on when the status changes.
//
// Behind the same switch as ONDC search: an order can only start from a
// search, so it is on for exactly the people who can search.
export const ondcOrdersRouter = Router();
ondcOrdersRouter.use((_req, res, next) => {
  if (!env.ONDC_SEARCH_ENABLED && env.ONDC_SEARCH_TESTERS.size === 0) return res.status(404).json({ error: "ONDC ordering is not enabled" });
  next();
});
ondcOrdersRouter.use(requireAuth);
ondcOrdersRouter.use(async (req, res, next) => {
  try {
    if (!(await ondcSearchFor(req.userId!))) return res.status(404).json({ error: "ONDC ordering is not enabled" });
    next();
  } catch (err) {
    next(err);
  }
});

const id = z.string().min(1).max(40).regex(/^[a-z0-9]+$/);
const lines = z
  .array(
    z
      .object({
        itemId: z.string().min(1).max(120),
        count: z.number().int().min(1).max(20),
        parentItemId: z.string().min(1).max(120).optional(),
        customizations: z.array(z.object({ itemId: z.string().min(1).max(120), groupId: z.string().min(1).max(120) }).strict()).max(20).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(30);

const startBody = z
  .object({
    searchId: z.string().uuid(),
    bppId: z.string().min(1).max(255),
    providerId: z.string().min(1).max(255),
    locationId: z.string().min(1).max(255),
    lines,
    addressId: z.string().min(1).max(40).optional(),
  })
  .strict();

ondcOrdersRouter.post("/", validateBody(startBody), async (req, res, next) => {
  try {
    res.status(202).json(await startOndcOrder(req.userId!, req.body));
  } catch (err) {
    next(err);
  }
});

ondcOrdersRouter.get("/:id", async (req, res, next) => {
  try {
    if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    res.json(await ondcOrderView(req.userId!, req.params.id!));
  } catch (err) {
    next(err);
  }
});

ondcOrdersRouter.post("/:id/init", async (req, res, next) => {
  try {
    if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    res.status(202).json(await initOndcOrder(req.userId!, req.params.id!));
  } catch (err) {
    next(err);
  }
});

// Paying. Flouna collects through Cashfree: this hands back a payment
// session for the seller's final total, and the order is placed with the
// seller when the gateway confirms the money (webhook or /verify). Demo mode
// outside production settles at once without a gateway, as the rest of the
// app's demo payments do.
ondcOrdersRouter.post("/:id/pay", async (req, res, next) => {
  try {
    if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    if (env.DEMO_PAYMENTS && !isProd) {
      const view = await ondcOrderView(req.userId!, req.params.id!);
      if (view.totalPaise == null) return res.status(409).json({ error: "This order has no total to pay yet" });
      await markOndcOrderPaid(view.id, { amountPaise: view.totalPaise, reference: `demo_${crypto.randomUUID()}` });
      return res.json({ mode: "demo", order: await ondcOrderView(req.userId!, view.id) });
    }
    res.json({ mode: "cashfree", ...(await startOndcPayment(req.userId!, req.params.id!)) });
  } catch (err) {
    next(err);
  }
});

// The customer is back from the gateway: whether they paid is asked of the
// gateway, never taken from the browser.
ondcOrdersRouter.post("/:id/verify", async (req, res, next) => {
  try {
    if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    res.json(await verifyOndcPayment(req.userId!, req.params.id!));
  } catch (err) {
    next(err);
  }
});

ondcOrdersRouter.post("/:id/confirm", async (req, res, next) => {
  try {
    if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    res.status(202).json(await confirmOndcOrder(req.userId!, req.params.id!));
  } catch (err) {
    next(err);
  }
});

ondcOrdersRouter.post("/:id/status", async (req, res, next) => {
  try {
    if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    res.status(202).json(await refreshOndcOrder(req.userId!, req.params.id!));
  } catch (err) {
    next(err);
  }
});

ondcOrdersRouter.post("/:id/track", async (req, res, next) => {
  try {
    if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    res.status(202).json(await trackOndcOrder(req.userId!, req.params.id!));
  } catch (err) {
    next(err);
  }
});

const cancelBody = z
  .object({ reasonId: z.enum(Object.keys(BUYER_CANCEL_REASONS) as [BuyerCancelReason, ...BuyerCancelReason[]]) })
  .strict();

ondcOrdersRouter.post("/:id/cancel", validateBody(cancelBody), async (req, res, next) => {
  try {
    if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    res.status(202).json(await cancelOndcOrder(req.userId!, req.params.id!, req.body.reasonId));
  } catch (err) {
    next(err);
  }
});
