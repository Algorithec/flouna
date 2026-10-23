import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { recommendProduct, searchProducts, searchProductsTraced, quotesForProduct } from "./shop.service.js";
import { products } from "../../data/products.js";

export const shopRouter = Router();
shopRouter.use(requireAuth);

const CATEGORIES = ["All", "Electronics", "Fashion", "Home", "Appliances"];

// Landing feed: trending picks + categories.
shopRouter.get("/feed", (_req, res, next) => {
  try {
    const picks = ["gaming-laptop-rtx", "wireless-earbuds", "running-shoes"]
      .map((id) => searchProducts({ query: products.find((p) => p.id === id)?.name ?? "" })[0])
      .filter((q) => q !== undefined);

    res.json({ categories: CATEGORIES, picks });
  } catch (err) {
    next(err);
  }
});

const searchQuery = z.object({
  q: z.string().max(120).default(""),
  budget: z.coerce.number().int().positive().optional(), // rupees
  category: z.enum(["electronics", "fashion", "home", "appliances"]).optional(),
});

shopRouter.get("/search", (req, res, next) => {
  try {
    const parsed = searchQuery.parse(req.query);
    const { quotes, substituted } = searchProductsTraced({
      query: parsed.q,
      budgetPaise: parsed.budget ? parsed.budget * 100 : null,
      category: parsed.category ?? null,
    });
    res.json({ quotes: quotes.slice(0, 24), substituted });
  } catch (err) {
    next(err);
  }
});

shopRouter.get("/recommend", (req, res, next) => {
  try {
    const parsed = searchQuery.parse(req.query);
    const rec = recommendProduct({
      query: parsed.q,
      budgetPaise: parsed.budget ? parsed.budget * 100 : null,
      category: parsed.category ?? null,
    });
    res.json({ recommendation: rec });
  } catch (err) {
    next(err);
  }
});

// All platform listings for one product (the comparison screen).
shopRouter.get("/products/:productId", (req, res) => {
  const quotes = quotesForProduct(req.params.productId);
  if (quotes.length === 0) {
    return res.status(404).json({ error: "Product not found" });
  }
  res.json({ quotes });
});
