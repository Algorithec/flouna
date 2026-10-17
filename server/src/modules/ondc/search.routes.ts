import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ondcSearchResults, startOndcSearch } from "./search.service.js";

// The customer's searches of ONDC sellers. Starting one sends it to the
// network; reading it back shows whatever seller apps have answered so far,
// so the app polls until it says complete.
export const ondcSearchRouter = Router();
ondcSearchRouter.use((_req, res, next) => {
  if (!env.ONDC_SEARCH_ENABLED) return res.status(404).json({ error: "ONDC search is not enabled" });
  next();
});
ondcSearchRouter.use(requireAuth);

// Each POST fans out a signed search to every seller app on the network, so
// limit one customer to a few per minute rather than the general 600/min.
const searchTimestamps = new Map<string, number[]>();
const SEARCH_LIMIT = 5;
const SEARCH_WINDOW_MS = 60_000;

ondcSearchRouter.post("/", validateBody(z.object({ query: z.string().trim().min(2).max(80) }).strict()), async (req, res, next) => {
  const userId = req.userId!;
  const now = Date.now();
  const stamps = (searchTimestamps.get(userId) ?? []).filter((t) => now - t < SEARCH_WINDOW_MS);
  if (stamps.length >= SEARCH_LIMIT) return res.status(429).json({ error: "Too many searches, try again in a minute" });
  stamps.push(now);
  searchTimestamps.set(userId, stamps);
  try {
    res.status(202).json(await startOndcSearch(req.userId!, req.body.query));
  } catch (err) {
    next(err);
  }
});

ondcSearchRouter.get("/:id", async (req, res, next) => {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "Search not found" });
    res.json(await ondcSearchResults(req.params.id!, req.userId!));
  } catch (err) {
    next(err);
  }
});
