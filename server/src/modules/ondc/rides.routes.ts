import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ondcSearchFor } from "./search.service.js";
import {
  chooseRide,
  confirmRide,
  confirmRideCancel,
  initRide,
  keepRide,
  quoteRideCancel,
  refreshRide,
  rideOffers,
  rideView,
  RIDER_CANCEL_REASONS,
  startRideSearch,
  trackRide,
  type RiderCancelReason,
} from "./rides.service.js";

// The rider's rides with ONDC ride providers. Like food, each step answers at
// once and the provider replies over the next seconds, so the app polls.
// Behind the same switch and tester list as ONDC food search.
export const ondcRidesRouter = Router();
ondcRidesRouter.use((_req, res, next) => {
  if (!env.ONDC_SEARCH_ENABLED && env.ONDC_SEARCH_TESTERS.size === 0) return res.status(404).json({ error: "ONDC rides are not enabled" });
  next();
});
ondcRidesRouter.use(requireAuth);
ondcRidesRouter.use(async (req, res, next) => {
  try {
    if (!(await ondcSearchFor(req.userId!))) return res.status(404).json({ error: "ONDC rides are not enabled" });
    next();
  } catch (err) {
    next(err);
  }
});

// Each search fans out to every ride provider on the network.
const searchStamps = new Map<string, number[]>();
const place = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), address: z.string().trim().min(3).max(200), area: z.string().trim().min(1).max(80) })
  .strict();

ondcRidesRouter.post("/", validateBody(z.object({ pickup: place, drop: place, city: z.string().trim().min(2).max(60) }).strict()), async (req, res, next) => {
  const now = Date.now();
  const stamps = (searchStamps.get(req.userId!) ?? []).filter((t) => now - t < 60_000);
  if (stamps.length >= 5) return res.status(429).json({ error: "Too many ride searches, try again in a minute" });
  searchStamps.set(req.userId!, [...stamps, now]);
  try {
    res.status(202).json(await startRideSearch(req.userId!, req.body));
  } catch (err) {
    next(err);
  }
});

const id = z.string().min(1).max(40).regex(/^[a-z0-9]+$/);
const withRide =
  (fn: (userId: string, rideId: string, body: unknown) => Promise<unknown>, code = 202) =>
  async (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    try {
      if (!id.safeParse(req.params.id).success) return res.status(404).json({ error: "Ride not found" });
      res.status(code).json((await fn(req.userId!, req.params.id!, req.body)) ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };

ondcRidesRouter.get("/:id", withRide((u, r) => rideView(u, r), 200));
ondcRidesRouter.get("/:id/offers", withRide((u, r) => rideOffers(u, r), 200));
ondcRidesRouter.post(
  "/:id/choose",
  validateBody(z.object({ bppId: z.string().min(1).max(255), providerId: z.string().min(1).max(255), itemId: z.string().min(1).max(255) }).strict()),
  withRide((u, r, b) => chooseRide(u, r, b as { bppId: string; providerId: string; itemId: string })),
);
ondcRidesRouter.post("/:id/init", withRide((u, r) => initRide(u, r)));
ondcRidesRouter.post("/:id/confirm", withRide((u, r) => confirmRide(u, r)));
ondcRidesRouter.post("/:id/status", withRide((u, r) => refreshRide(u, r)));
ondcRidesRouter.post("/:id/track", withRide((u, r) => trackRide(u, r)));
ondcRidesRouter.post(
  "/:id/cancel",
  validateBody(z.object({ reasonId: z.enum(Object.keys(RIDER_CANCEL_REASONS) as [RiderCancelReason, ...RiderCancelReason[]]) }).strict()),
  withRide((u, r, b) => quoteRideCancel(u, r, (b as { reasonId: RiderCancelReason }).reasonId)),
);
ondcRidesRouter.post("/:id/cancel/confirm", withRide((u, r) => confirmRideCancel(u, r)));
ondcRidesRouter.post("/:id/cancel/keep", withRide((u, r) => keepRide(u, r), 200));
