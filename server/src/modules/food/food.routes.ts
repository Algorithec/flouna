import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { recordDecision } from "../advisor/decisionLog.service.js";
import {
  recommendFood,
  searchFood,
  quotesForDish,
  allQuotes,
  withoutTrace,
} from "./food.service.js";
import { withCommunityRatings, allCommunityRatings } from "../ratings/ratings.service.js";
import { dishes } from "../../data/restaurants.js";
import { adviseFood } from "../advisor/advisor.service.js";
import { recordObservation } from "../advisor/priceHistory.service.js";
import { prisma } from "../../lib/prisma.js";
import { istDayKey } from "../../lib/istTime.js";

export const foodRouter = Router();
foodRouter.use(requireAuth);

const CATEGORIES = ["All", "Burger", "Pizza", "Healthy", "South Indian", "Dessert"];

// Landing feed: AI picks + smart suggestion stats, per the Figma food landing.
foodRouter.get("/feed", async (_req, res, next) => {
  try {
    const picks = ["quinoa-bowl", "mushroom-pasta", "masala-dosa"]
      .map((id) => dishes.find((d) => d.id === id))
      .filter((d) => d !== undefined)
      .map((d) => {
        const best = searchFood({ query: d.name })[0];
        return best;
      })
      .filter((q) => q !== undefined);

    const all = allQuotes();
    const fastest = Math.min(...all.map((q) => q.etaMinutes));
    const topRated = dishes.filter((d) => d.rating >= 4.0).length;

    res.json({
      categories: CATEGORIES,
      picks: await withCommunityRatings("food", picks, (q) => q.dishId),
      suggestions: {
        fastestDeliveryMinutes: fastest,
        nearestKm: 1.5,
        topRatedCount: topRated,
      },
      advice: await adviseFood(null),
    });
  } catch (err) {
    next(err);
  }
});

const searchQuery = z.object({
  q: z.string().max(120).default(""),
  budget: z.coerce.number().int().positive().optional(), // rupees
  dietary: z.enum(["veg", "nonveg", "any"]).default("any"),
});

foodRouter.get("/search", async (req, res, next) => {
  try {
    const parsed = searchQuery.parse(req.query);
    const quotes = searchFood({
      query: parsed.q,
      budgetPaise: parsed.budget ? parsed.budget * 100 : null,
      dietary: parsed.dietary,
    });
    res.json({
      quotes: await withCommunityRatings(
        "food",
        quotes.slice(0, 24),
        (q) => q.dishId,
      ),
    });
  } catch (err) {
    next(err);
  }
});

foodRouter.get("/recommend", async (req, res, next) => {
  try {
    const parsed = searchQuery.parse(req.query);
    const rec = recommendFood({
      query: parsed.q,
      budgetPaise: parsed.budget ? parsed.budget * 100 : null,
      dietary: parsed.dietary,
      community: await allCommunityRatings("food"),
    });
    // Handed to the client so that, if this recommendation becomes an order,
    // the order can be paired back to the ranking that produced it.
    const decisionId = rec
      ? recordDecision({
          userId: req.userId,
          domain: "food",
          query: parsed.q,
          trace: rec.trace,
        })
      : null;
    // Without the trace: the reasoning goes to the decision log, not to the
    // browser, which never reads it.
    res.json({ recommendation: rec ? withoutTrace(rec) : null, decisionId });
  } catch (err) {
    next(err);
  }
});

// Quote detail for the order screen — dish + chosen platform listing.
foodRouter.get("/dishes/:dishId", async (req, res, next) => {
  try {
    const quotes = quotesForDish(req.params.dishId);
    if (quotes.length === 0) {
      return res.status(404).json({ error: "Dish not found" });
    }
    res.json({
      quotes: await withCommunityRatings("food", quotes, (q) => q.dishId),
    });
  } catch (err) {
    next(err);
  }
});

// Daily price history for a dish, from observed quotes. Returns one point per
// day (the day's lowest observed price). Powers the trend chart.
foodRouter.get("/dishes/:dishId/price-history", async (req, res, next) => {
  try {
    const days = z.coerce.number().int().min(1).max(90).default(30).parse(req.query.days);
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await prisma.priceObservation.findMany({
      where: { domain: "food", key: req.params.dishId, createdAt: { gte: since } },
      select: { bestPaise: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Bucket by calendar day → that day's minimum observed price.
    //
    // The customer's calendar day, not the host's. toISOString() is UTC, so on
    // the Railway servers every price seen between midnight and half past five
    // in the morning IST was filed under the previous day: the chart's last
    // point was yesterday's low labelled as today's, which is exactly the
    // reading a "wait, it usually drops tomorrow" decision is made on.
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const day = istDayKey(r.createdAt);
      const cur = byDay.get(day);
      if (cur === undefined || r.bestPaise < cur) byDay.set(day, r.bestPaise);
    }
    const points = [...byDay.entries()].map(([date, pricePaise]) => ({ date, pricePaise }));

    res.json({ dishId: req.params.dishId, points });
  } catch (err) {
    next(err);
  }
});
