import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { addItem, clearCart, getCart, importLocalCart, MAX_LINES, MAX_QTY, removeItem, setQty } from "./cart.service.js";

// The customer's cart. Every route answers with the whole cart as it now
// stands, so the app never has to work out the result of a change itself.
export const cartRouter = Router();
cartRouter.use(requireAuth);

const ID = z.string().trim().min(1).max(64);
const line = { dishId: ID, platform: ID };

cartRouter.get("/", async (req, res, next) => {
  try {
    res.json(await getCart(req.userId!));
  } catch (err) {
    next(err);
  }
});

cartRouter.post(
  "/items",
  validateBody(
    z.object({ ...line, qty: z.number().int().min(1).max(MAX_QTY).optional(), decisionId: ID.optional() }).strict(),
  ),
  async (req, res, next) => {
    try {
      res.json(await addItem(req.userId!, { ...req.body, via: "app" }));
    } catch (err) {
      next(err);
    }
  },
);

cartRouter.patch(
  "/items",
  validateBody(z.object({ ...line, qty: z.number().int().min(0).max(MAX_QTY) }).strict()),
  async (req, res, next) => {
    try {
      res.json(await setQty(req.userId!, req.body));
    } catch (err) {
      next(err);
    }
  },
);

cartRouter.delete("/items", validateBody(z.object(line).strict()), async (req, res, next) => {
  try {
    res.json(await removeItem(req.userId!, req.body));
  } catch (err) {
    next(err);
  }
});

cartRouter.delete("/", async (req, res, next) => {
  try {
    res.json(await clearCart(req.userId!));
  } catch (err) {
    next(err);
  }
});

cartRouter.post(
  "/import",
  validateBody(
    z
      .object({
        lines: z
          .array(z.object({ ...line, qty: z.number().int().min(1).max(MAX_QTY), decisionId: ID.optional() }).passthrough())
          .max(MAX_LINES),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const lines = (req.body.lines as { dishId: string; platform: string; qty: number; decisionId?: string }[]).map(
        ({ dishId, platform, qty, decisionId }) => ({ dishId, platform, qty, decisionId }),
      );
      res.json(await importLocalCart(req.userId!, lines));
    } catch (err) {
      next(err);
    }
  },
);
