import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { quotesForDish } from "../food/food.service.js";
import { quoteRides, fetchRoute } from "../rides/rides.service.js";
import { env } from "../../config/env.js";
import { rideProvider } from "../providers/index.js";
import {
  isPlusActive,
  CONVENIENCE_FEE_PAISE,
} from "../subscription/subscription.service.js";
import { sendPushToUser } from "../notifications/push.service.js";
import { emitOrderDiscovery } from "../backoffice/ondc.service.js";

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

// Deterministic restaurant → delivery coordinates near Hyderabad for the live
// delivery map. Same dish always yields the same short route. Replaced by real
// ONDC restaurant + delivery-address coordinates once the network is live.
function simulateDeliveryCoords(seed: string): {
  restaurantLat: number;
  restaurantLng: number;
  deliveryLat: number;
  deliveryLng: number;
} {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const baseLat = 17.43; // Hyderabad
  const baseLng = 78.4;
  const jitter = (n: number) => ((n % 1000) / 1000 - 0.5) * 0.06; // ~±3km
  return {
    restaurantLat: baseLat + jitter(h),
    restaurantLng: baseLng + jitter(h >> 5),
    deliveryLat: baseLat + jitter(h >> 10) + 0.015,
    deliveryLng: baseLng + jitter(h >> 15) + 0.015,
  };
}

const createFoodOrder = z.object({
  domain: z.literal("food"),
  dishId: z.string().max(60),
  platform: z.enum(["ondc", "swiggy", "zomato"]),
});

// Multi-item cart checkout: one order with line items. Every price is
// recomputed from the catalog per line; the client only sends ids + qty.
const createFoodCartOrder = z.object({
  domain: z.literal("food"),
  items: z
    .array(
      z.object({
        dishId: z.string().max(60),
        platform: z.enum(["ondc", "swiggy", "zomato"]),
        qty: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(30),
  instructions: z.string().trim().max(300).optional(),
});

// The client sends pickup/drop COORDINATES, not a distance. The server
// recomputes distance+time itself so the fare can't be gamed by faking a
// short trip. Labels (pickup/drop strings) are display-only.
const createRideOrder = z.object({
  domain: z.literal("ride"),
  provider: z.enum(["uber", "ola", "rapido", "ondc"]),
  productName: z.string().max(60),
  pickup: z.string().max(160),
  drop: z.string().max(160),
  pickupLat: z.number().min(-90).max(90),
  pickupLng: z.number().min(-180).max(180),
  dropLat: z.number().min(-90).max(90),
  dropLng: z.number().min(-180).max(180),
  // Ride scheduling ("book a cab at 10pm"). Omitted = ride now. Must be in
  // the future but within a week; the captain search begins at this time.
  scheduledAt: z.string().datetime().optional(),
});

// Prices are always recomputed server-side from the catalog/quote engine —
// a tampered client cannot set its own amount.
ordersRouter.post(
  "/",
  // Cart variant first: both food shapes share domain, so plain union with
  // the more specific (items[]) schema ahead.
  validateBody(z.union([createFoodCartOrder, createFoodOrder, createRideOrder])),
  async (req, res, next) => {
    try {
      const body = req.body as
        | z.infer<typeof createFoodCartOrder>
        | z.infer<typeof createFoodOrder>
        | z.infer<typeof createRideOrder>;

      // ---------- multi-item cart ----------
      if (body.domain === "food" && "items" in body) {
        type Line = {
          dishId: string;
          platform: string;
          name: string;
          restaurant: string;
          qty: number;
          pricePaise: number; // unit base price
          offer: { label: string; discountPaise: number } | null;
        };
        const lines: Line[] = [];
        let itemsTotal = 0;
        let discount = 0;
        let deliveryFeePaise = 0;
        let savedPaise = 0;
        const offers: { label: string; discountPaise: number }[] = [];

        for (const item of body.items) {
          const quotes = quotesForDish(item.dishId);
          const quote = quotes.find((q) => q.platform === item.platform);
          if (!quote) {
            throw new ApiError(404, `An item in your cart is no longer available`);
          }
          itemsTotal += quote.basePaise * item.qty;
          // One delivery per order — charge the highest fee among the lines,
          // never a per-line stack.
          deliveryFeePaise = Math.max(deliveryFeePaise, quote.deliveryFeePaise);
          const lineOffer = quote.offers[0] ?? null;
          if (lineOffer) {
            discount += lineOffer.discountPaise;
            offers.push(lineOffer);
          }
          const cheapestOther = Math.min(
            ...quotes
              .filter((q) => q.platform !== item.platform)
              .map((q) => q.effectivePaise),
          );
          if (Number.isFinite(cheapestOther)) {
            savedPaise += Math.max(0, cheapestOther - quote.effectivePaise);
          }
          lines.push({
            dishId: item.dishId,
            platform: item.platform,
            name: quote.name,
            restaurant: quote.restaurant,
            qty: item.qty,
            pricePaise: quote.basePaise,
            offer: lineOffer,
          });
        }

        const defaultAddress = await prisma.address.findFirst({
          where: { userId: req.userId!, isDefault: true },
        });
        const me = await prisma.user.findUniqueOrThrow({
          where: { id: req.userId! },
          select: { plusActive: true, plusUntil: true },
        });
        const convenienceFeePaise = !isPlusActive(me) ? CONVENIENCE_FEE_PAISE : 0;
        const amount = Math.max(
          0,
          itemsTotal + deliveryFeePaise + convenienceFeePaise - discount,
        );

        const first = lines[0]!;
        const { restaurantLat, restaurantLng, deliveryLat, deliveryLng } =
          simulateDeliveryCoords(first.dishId);

        const order = await prisma.order.create({
          data: {
            userId: req.userId!,
            domain: "food",
            status: "pending_payment",
            provider: first.platform,
            fulfillment: "in_app",
            title:
              lines.length > 1
                ? `${first.name} + ${lines.length - 1} more — ${first.restaurant}`
                : `${first.name} — ${first.restaurant}`,
            details: JSON.stringify({
              items: lines.map((l) => ({
                dishId: l.dishId,
                name: l.name,
                qty: l.qty,
                pricePaise: l.pricePaise,
              })),
              name: first.name,
              restaurant: first.restaurant,
              basePaise: itemsTotal,
              deliveryFeePaise,
              convenienceFeePaise,
              offers,
              instructions: body.instructions || undefined,
              pickupLat: restaurantLat,
              pickupLng: restaurantLng,
              dropLat: deliveryLat,
              dropLng: deliveryLng,
              vehicle: "bike",
              comparedOptions: lines.length * 3,
              comparedPlatforms: 3,
            }),
            amount,
            savedPaise,
            addressId: defaultAddress?.id ?? null,
          },
        });
        void emitOrderDiscovery(order);
        return res.status(201).json({ order });
      }

      if (body.domain === "food") {
        const allQuotes = quotesForDish(body.dishId);
        const quote = allQuotes.find((q) => q.platform === body.platform);
        if (!quote) throw new ApiError(404, "That option is no longer available");

        // Savings vs the cheapest alternative platform for the same dish —
        // the number behind "you always got the best price".
        const cheapestOther = Math.min(
          ...allQuotes
            .filter((q) => q.platform !== body.platform)
            .map((q) => q.effectivePaise),
        );
        const savedPaise = Number.isFinite(cheapestOther)
          ? Math.max(0, cheapestOther - quote.effectivePaise)
          : 0;

        const defaultAddress = await prisma.address.findFirst({
          where: { userId: req.userId!, isDefault: true },
        });

        // Radiues Plus perk: in-app convenience fee is waived for subscribers.
        const me = await prisma.user.findUniqueOrThrow({
          where: { id: req.userId! },
          select: { plusActive: true, plusUntil: true },
        });
        const convenienceFeePaise =
          quote.fulfillment === "in_app" && !isPlusActive(me)
            ? CONVENIENCE_FEE_PAISE
            : 0;

        // Restaurant → delivery coordinates power the live delivery map on the
        // order screen. Simulated near a city centre for now (a short, realistic
        // route); real ONDC restaurant + address coordinates replace these.
        const { restaurantLat, restaurantLng, deliveryLat, deliveryLng } =
          simulateDeliveryCoords(body.dishId);

        const order = await prisma.order.create({
          data: {
            userId: req.userId!,
            domain: "food",
            status: "pending_payment",
            provider: quote.platform,
            fulfillment: quote.fulfillment,
            title: `${quote.name} — ${quote.restaurant}`,
            details: JSON.stringify({
              ...quote,
              convenienceFeePaise,
              // Delivery map: restaurant (pickup) → delivery address (drop).
              pickupLat: restaurantLat,
              pickupLng: restaurantLng,
              dropLat: deliveryLat,
              dropLng: deliveryLng,
              vehicle: "bike",
              // decision-receipt stats, frozen at decision time
              comparedOptions: allQuotes.length,
              comparedPlatforms: new Set(allQuotes.map((q) => q.platform)).size,
            }),
            amount: quote.effectivePaise + convenienceFeePaise,
            savedPaise,
            addressId: defaultAddress?.id ?? null,
          },
        });
        // Record the simulated ONDC discovery flow (search/select) for the
        // developer transaction viewer. Fire-and-forget — never blocks the order.
        void emitOrderDiscovery(order);
        return res.status(201).json({ order });
      }

      // Recompute the trip from coordinates — never trust a client distance.
      // Real road geometry (ORS when keyed, offline estimate otherwise) is
      // stored so the live-tracking marker follows the actual route.
      const route = await fetchRoute(
        body.pickupLat,
        body.pickupLng,
        body.dropLat,
        body.dropLng,
        env.ORS_KEY,
      );
      const { distanceKm, rideMinutes } = route;
      const quotes = quoteRides({ distanceKm, rideMinutes });
      const quote = quotes.find(
        (q) => q.provider === body.provider && q.productName === body.productName,
      );
      if (!quote) throw new ApiError(404, "That ride option is no longer available");

      // Savings vs the cheapest other option of the same vehicle type.
      const cheapestOther = Math.min(
        ...quotes
          .filter((q) => q.vehicle === quote.vehicle && q !== quote)
          .map((q) => q.effectivePaise),
      );
      const savedPaise = Number.isFinite(cheapestOther)
        ? Math.max(0, cheapestOther - quote.effectivePaise)
        : 0;

      let scheduledAt: string | undefined;
      if (body.scheduledAt) {
        const when = new Date(body.scheduledAt);
        const leadMs = when.getTime() - Date.now();
        if (leadMs < 5 * 60_000)
          throw new ApiError(400, "Scheduled rides need at least 5 minutes' notice");
        if (leadMs > 7 * 24 * 3600_000)
          throw new ApiError(400, "Rides can be scheduled up to 7 days ahead");
        scheduledAt = when.toISOString();
      }

      const order = await prisma.order.create({
        data: {
          userId: req.userId!,
          domain: "ride",
          status: "pending_payment",
          provider: quote.provider,
          fulfillment: quote.fulfillment,
          title: `${quote.displayName}: ${body.pickup} → ${body.drop}`,
          details: JSON.stringify({
            ...quote,
            pickup: body.pickup,
            drop: body.drop,
            // Coordinates power the live tracking map on the order screen.
            pickupLat: body.pickupLat,
            pickupLng: body.pickupLng,
            dropLat: body.dropLat,
            dropLng: body.dropLng,
            distanceKm,
            // For the fulfilment provider's live tracking.
            vehicle: quote.vehicle,
            routeGeometry: route.geometry,
            comparedOptions: quotes.length,
            comparedPlatforms: new Set(quotes.map((q) => q.provider)).size,
            // Set only for scheduled rides; the tracking timeline (and the
            // captain search) anchors here instead of at payment time.
            scheduledAt,
          }),
          amount: quote.effectivePaise,
          savedPaise,
        },
      });
      void emitOrderDiscovery(order);
      res.status(201).json({ order });
    } catch (err) {
      next(err);
    }
  },
);

ordersRouter.get("/", async (req, res, next) => {
  try {
    const domain = req.query.domain;
    const orders = await prisma.order.findMany({
      where: {
        userId: req.userId!,
        ...(domain === "food" || domain === "ride" ? { domain } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        domain: true,
        status: true,
        provider: true,
        title: true,
        amount: true,
        savedPaise: true,
        createdAt: true,
      },
    });
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

ordersRouter.get("/:id", async (req, res, next) => {
  try {
    let order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      include: {
        trackingEvents: { orderBy: { createdAt: "asc" } },
        payment: {
          select: { status: true, method: true, gatewayOrderId: true },
        },
      },
    });
    if (!order) throw new ApiError(404, "Order not found");

    // Lazy lifecycle completion: once every tracking step has elapsed,
    // a confirmed order becomes completed (real ONDC webhooks replace this).
    if (
      order.status === "confirmed" &&
      order.trackingEvents.length > 0 &&
      order.trackingEvents.every((e) => e.createdAt <= new Date())
    ) {
      order = {
        ...order,
        ...(await prisma.order.update({
          where: { id: order.id },
          data: { status: "completed" },
        })),
      };
    }

    res.json({
      order: { ...order, details: JSON.parse(order.details) },
    });
  } catch (err) {
    next(err);
  }
});

// Live fulfilment tracking for a ride — driver, OTP, vehicle and live GPS.
// Backed by the active provider (simulation now, real ONDC once onboarded).
// Works for every user; never gated behind subscription.
ordersRouter.get("/:id/track", async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      include: { trackingEvents: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!order) throw new ApiError(404, "Order not found");
    // Both rides and food deliveries get live tracking (food = delivery partner).
    if (order.status === "pending_payment")
      throw new ApiError(409, "Order not confirmed yet");

    // A cancelled ride reports a terminal state — the provider clock no longer
    // applies.
    if (order.status === "cancelled") {
      return res.json({
        tracking: {
          providerRef: `SIM-${order.id.slice(0, 8).toUpperCase()}`,
          state: "cancelled",
          otp: "----",
          driver: null,
          driverLocation: null,
          pickupEtaMinutes: 0,
          dropEtaMinutes: 0,
          statusMessage:
            order.domain === "food"
              ? "This order was cancelled"
              : "This ride was cancelled",
        },
      });
    }

    const d = JSON.parse(order.details) as {
      pickupLat?: number;
      pickupLng?: number;
      dropLat?: number;
      dropLng?: number;
      vehicle?: "bike" | "auto" | "cab";
      routeGeometry?: [number, number][];
    };
    if (
      d.pickupLat == null ||
      d.pickupLng == null ||
      d.dropLat == null ||
      d.dropLng == null
    ) {
      throw new ApiError(409, "This ride predates live tracking");
    }

    // The captain search begins when the ride is confirmed (first tracking
    // event), so the simulation's clock is anchored there. For scheduled
    // rides that anchor is the scheduled time — until it arrives, report a
    // calm "scheduled" placeholder instead of a fake live search.
    const bookedAt = order.trackingEvents[0]?.createdAt ?? order.createdAt;
    if (bookedAt.getTime() > Date.now()) {
      const when = bookedAt.toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
      });
      return res.json({
        tracking: {
          providerRef: `SIM-${order.id.slice(0, 8).toUpperCase()}`,
          state: "searching",
          otp: "----",
          driver: null,
          driverLocation: null,
          pickupEtaMinutes: Math.ceil((bookedAt.getTime() - Date.now()) / 60_000),
          dropEtaMinutes: 0,
          statusMessage: `Ride scheduled for ${when} — we'll find your captain then`,
        },
      });
    }
    const pickup = { lat: d.pickupLat, lng: d.pickupLng };
    const drop = { lat: d.dropLat, lng: d.dropLng };
    const geometry =
      d.routeGeometry ??
      ([
        [d.pickupLng, d.pickupLat],
        [d.dropLng, d.dropLat],
      ] as [number, number][]);

    const assignment = await rideProvider.track({
      orderId: order.id,
      providerRef: `SIM-${order.id.slice(0, 8).toUpperCase()}`,
      vehicle: d.vehicle ?? "cab",
      pickup,
      drop,
      routeGeometry: geometry,
      bookedAt,
      domain: order.domain === "food" ? "food" : "ride",
    });

    res.json({ tracking: assignment });
  } catch (err) {
    next(err);
  }
});

// Cancel an order. Rides: allowed while live (searching → in progress), like
// Uber/Ola. Food: allowed only until the delivery partner picks the order up
// (before the out_for_delivery stage) — the Swiggy/Zomato policy; once food is
// on the road it can't be cancelled. Never once completed/cancelled.
ordersRouter.post(
  "/:id/cancel",
  validateBody(
    z.object({ reason: z.string().trim().max(200).optional() }),
  ),
  async (req, res, next) => {
    try {
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, userId: req.userId! },
      });
      if (!order) throw new ApiError(404, "Order not found");
      const isFood = order.domain === "food";
      if (order.status === "completed")
        throw new ApiError(
          409,
          isFood ? "This order is already delivered" : "This trip is already completed",
        );
      if (order.status === "cancelled")
        throw new ApiError(409, "Already cancelled");

      // Food cut-off: once the out_for_delivery stage has been reached, the
      // order is with the delivery partner and can no longer be cancelled.
      if (isFood) {
        const pickedUp = await prisma.trackingEvent.findFirst({
          where: {
            orderId: order.id,
            status: "out_for_delivery",
            createdAt: { lte: new Date() },
          },
        });
        if (pickedUp) {
          throw new ApiError(
            409,
            "Your order is already out for delivery and can't be cancelled",
          );
        }
      }

      await rideProvider.cancel({
        orderId: order.id,
        providerRef: `SIM-${order.id.slice(0, 8).toUpperCase()}`,
      });

      // Keep the cancellation reason ("Help us improve" sheet) on the order —
      // ops reads it in the console, and it feeds churn analysis later.
      const { reason } = req.body as { reason?: string };
      const details = JSON.parse(order.details) as Record<string, unknown>;
      if (reason) details.cancelReason = reason;

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: { status: "cancelled", details: JSON.stringify(details) },
      });

      void sendPushToUser(order.userId, {
        title: isFood ? "Order cancelled" : "Ride cancelled",
        body: `${order.title} was cancelled.`,
        url: `/orders/${order.id}`,
      });

      res.json({ order: { ...updated, details: JSON.parse(updated.details) } });
    } catch (err) {
      next(err);
    }
  },
);
