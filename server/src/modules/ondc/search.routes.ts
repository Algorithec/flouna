import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ondcSearchResults, startOndcSearch } from "./search.service.js";

// The customer's searches of ONDC sellers. Starting one sends it to the
// network; reading it back shows whatever seller apps have answered so far,
// so the app polls until it says complete.
export const ondcSearchRouter = Router();
ondcSearchRouter.use(requireAuth);

ondcSearchRouter.post("/", validateBody(z.object({ query: z.string().trim().min(2).max(80) }).strict()), async (req, res, next) => {
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
