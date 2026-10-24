import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";

// The customer's own ONDC food orders and rides, for their history and for
// "Need help" on one of them.
//
// Not behind the ONDC switch: someone who ordered while it was on must still
// be able to find that order, and complain about it, after it is turned off.

export const ondcMineRouter = Router();
ondcMineRouter.use(requireAuth);

/** Orders that got as far as money or a seller's acceptance. A price check that went nowhere is not history. */
const FOOD_SHOWN = ["paid", "confirming", "placed", "cancelling", "cancelled", "failed"];
const RIDE_SHOWN = ["booked", "cancel_quoting", "cancel_quoted", "cancelling", "cancelled", "completed"];

/** The history shows this many, newest first, across food and rides together. */
const SHOWN = 50;

/** Where a ride went, or "" if what is stored does not read: one bad row must not fail the list. */
function dropAddress(json: string): string {
  try {
    const address = (JSON.parse(json) as { address?: unknown } | null)?.address;
    return typeof address === "string" ? address : "";
  } catch {
    return "";
  }
}

/** How many lines a food order had, or null if they do not read. */
function lineCount(json: string): number | null {
  try {
    const lines = JSON.parse(json) as unknown;
    return Array.isArray(lines) ? lines.length : null;
  } catch {
    return null;
  }
}

type Entry = {
  id: string;
  kind: "food" | "ride";
  title: string;
  status: string;
  amountPaise: number | null;
  createdAt: string;
  href: string;
};

ondcMineRouter.get("/", async (req, res, next) => {
  try {
    const [orders, rides] = await Promise.all([
      prisma.ondcOrder.findMany({
        where: { userId: req.userId!, status: { in: FOOD_SHOWN } },
        orderBy: { createdAt: "desc" },
        take: SHOWN,
        select: { id: true, storeName: true, status: true, sellerState: true, totalPaise: true, createdAt: true },
      }),
      prisma.ondcRide.findMany({
        where: { userId: req.userId!, status: { in: RIDE_SHOWN } },
        orderBy: { createdAt: "desc" },
        take: SHOWN,
        select: { id: true, drop: true, status: true, farePaise: true, createdAt: true },
      }),
    ]);
    const entries: Entry[] = [
      // A delivered food order is still "placed" on our side; the seller's word decides it is done.
      ...orders.map((o) => ({ id: o.id, kind: "food" as const, title: o.storeName, status: o.sellerState === "Completed" ? "completed" : o.status, amountPaise: o.totalPaise, createdAt: o.createdAt.toISOString(), href: `/food/ondc/${o.id}` })),
      ...rides.map((r) => ({
        id: r.id,
        kind: "ride" as const,
        title: dropAddress(r.drop),
        status: r.status,
        amountPaise: r.farePaise,
        createdAt: r.createdAt.toISOString(),
        href: `/rides/ondc/${r.id}`,
      })),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      // Fifty in all, not fifty of each.
      .slice(0, SHOWN);
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});

/** One of them, by id, for the help screen: what it was and when. */
ondcMineRouter.get("/:id", async (req, res, next) => {
  try {
    if (!z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
    const where = { id: req.params.id!, userId: req.userId! };
    const food = await prisma.ondcOrder.findFirst({ where, select: { storeName: true, createdAt: true, lines: true } });
    if (food) {
      return res.json({ kind: "food", title: food.storeName, createdAt: food.createdAt.toISOString(), itemCount: lineCount(food.lines) });
    }
    const ride = await prisma.ondcRide.findFirst({ where, select: { drop: true, createdAt: true } });
    if (ride) {
      return res.json({ kind: "ride", title: dropAddress(ride.drop), createdAt: ride.createdAt.toISOString(), itemCount: null });
    }
    res.status(404).json({ error: "Order not found" });
  } catch (err) {
    next(err);
  }
});
