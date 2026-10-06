import crypto from "node:crypto";
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { cancellationTerms, refundWindowDays } from "./cancellation.service.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { quotesForDish } from "../food/food.service.js";
import { priceFoodCart, type CartItem } from "./cartPricing.js";
import { quoteRides, fetchRoute } from "../rides/rides.service.js";
import { quotesForProduct } from "../shop/shop.service.js";
import { recordSelection } from "../advisor/decisionLog.service.js";
import { env } from "../../config/env.js";
import { rideProvider } from "../providers/index.js";
import { catchUpDriverMessages } from "../rides/rideChat.service.js";
import { creditCashback, refundToWallet } from "../users/wallet.service.js";
import { getConfig } from "../backoffice/config.service.js";
import {
  isPlusActive,
  CONVENIENCE_FEE_PAISE,
} from "../subscription/subscription.service.js";
import { sendPushToUser } from "../notifications/push.service.js";
import { evaluateCoupon, createOrderClaimingCoupon } from "../coupons/coupons.service.js";
import { enqueueNotification } from "../notifications/outbox.service.js";
import { emitOrderDiscovery } from "../backoffice/ondc.service.js";
import { istTimeLabel } from "../../lib/istTime.js";

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

// Food is delivered to a place, so an order without one is meaningless — the
// address is required, not best-effort. Prefers the default, falls back to the
// most recent (a user can have addresses with none flagged default).
async function requireDeliveryAddress(userId: string) {
  const address =
    (await prisma.address.findFirst({
      where: { userId, isDefault: true },
    })) ??
    (await prisma.address.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    }));
  if (!address) {
    throw new ApiError(400, "Add a delivery address before placing the order");
  }
  return address;
}

// Pairs the order back to the ranking that produced it, so the decision log
// records the option taken and not only the option offered. Optional
// throughout: an order placed from a screen that never ran a ranking, or by a
// client that predates this, is still a perfectly good order.
const createFoodOrder = z.object({
  domain: z.literal("food"),
  dishId: z.string().max(60),
  platform: z.enum(["ondc", "swiggy", "zomato"]),
  couponCode: z.string().trim().max(24).optional(),
  decisionId: z.string().max(64).optional(),
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
        // Per line, not per order: a cart can hold items from several
        // recommendations, and one id on the order could be paired with only
        // one of them with nothing to say which.
        decisionId: z.string().max(64).optional(),
      }),
    )
    .min(1)
    .max(30),
  instructions: z.string().trim().max(300).optional(),
  couponCode: z.string().trim().max(24).optional(),
});

// The client sends pickup/drop COORDINATES, not a distance. The server
// recomputes distance+time itself so the fare can't be gamed by faking a
// short trip. Labels (pickup/drop strings) are display-only.
const createRideOrder = z.object({
  domain: z.literal("ride"),
  decisionId: z.string().max(64).optional(),
  // The fare the app showed. Never used as the price, which the server works
  // out itself; only compared, so a fare that moved while the rider sat on the
  // review screen is reported rather than charged.
  expectedPaise: z.number().int().positive().optional(),
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

const createShopOrder = z.object({
  domain: z.literal("shop"),
  productId: z.string().max(60),
  platform: z.string().max(60),
  couponCode: z.string().trim().max(24).optional(),
});

// Prices are always recomputed server-side from the catalog/quote engine —
// a tampered client cannot set its own amount.
/**
 * The client's key for one order attempt, if it sent one.
 *
 * A double-tap, a connection that retried, or a back-then-submit all send the
 * same request again, and each one used to become its own order the customer
 * could be charged for. Verified against the live app: three identical
 * requests produced three orders.
 *
 * Deliberately only an explicit key, never a hash of the body. Those answer
 * different questions: a key means "this is a retry of that attempt", while a
 * matching body only means "you ordered the same thing", and ordering the same
 * dish twice is something people genuinely do. Deduping on content silently
 * refused the second one, which the test suite caught by buying a dish twice
 * on purpose.
 *
 * A caller that sends no key gets no protection, which is the honest trade:
 * the alternative was protecting it from a second order it actually wanted.
 */
function requestFingerprint(req: Request): string | null {
  const supplied = req.get("idempotency-key")?.trim();
  if (!supplied || supplied.length > 200) return null;
  return supplied;
}

/**
 * How long the same request keeps returning the same order.
 *
 * Long enough to cover a retry and a frustrated second tap, short enough that
 * genuinely ordering the same thing again later still works. Somebody booking
 * an identical trip twice within two minutes is rare; being charged twice for
 * one tap is not something to risk against it.
 */
const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

ordersRouter.post(
  "/",
  // Cart variant first: both food shapes share domain, so plain union with
  // the more specific (items[]) schema ahead.
  validateBody(z.union([createFoodCartOrder, createFoodOrder, createRideOrder, createShopOrder])),
  async (req, res, next) => {
    // Outside the try so the conflict handler below can still see it.
    const fingerprint = requestFingerprint(req);
    try {
      // A retry of an attempt we already completed? Hand back the order it
      // made rather than making a second one.
      if (fingerprint) {
        const recent = await prisma.order.findFirst({
          where: {
            userId: req.userId!,
            ...(fingerprint ? { requestKey: fingerprint } : {}),
            createdAt: { gte: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS) },
          },
          orderBy: { createdAt: "desc" },
        });
        if (recent) {
          res.status(200).json({ order: recent, deduplicated: true });
          return;
        }
      }

      const body = req.body as
        | z.infer<typeof createFoodCartOrder>
        | z.infer<typeof createFoodOrder>
        | z.infer<typeof createRideOrder>
        | z.infer<typeof createShopOrder>;

      // ---------- multi-item cart ----------
      if (body.domain === "food" && "items" in body) {
        const me = await prisma.user.findUniqueOrThrow({
          where: { id: req.userId! },
          select: { plusActive: true, plusUntil: true },
        });
        const convenienceFeePaise = !isPlusActive(me) ? CONVENIENCE_FEE_PAISE : 0;
        // The same function the cart screen's preview answers with, so the
        // total shown and the amount charged cannot drift apart. Priced before
        // the address is required, which is the order the messages came in
        // before: an item that has gone is worth saying first.
        const bill = priceFoodCart(body.items, { convenienceFeePaise });
        const defaultAddress = await requireDeliveryAddress(req.userId!);
        const {
          lines,
          itemsTotalPaise: itemsTotal,
          deliveryFeePaise,
          offers,
          offersDiscountPaise: discount,
          savedPaise,
        } = bill;

        // Promo code — re-evaluated here (never trusted from the client) and
        // applied to the item subtotal, on top of any per-line offers.
        let couponDiscount = 0;
        let coupon: { couponId: string; code: string; description: string } | null = null;
        if (body.couponCode) {
          const check = await evaluateCoupon({
            code: body.couponCode,
            userId: req.userId!,
            domain: "food",
            subtotalPaise: itemsTotal,
          });
          if (!check.ok) throw new ApiError(400, check.reason);
          couponDiscount = check.discountPaise;
          coupon = {
            couponId: check.couponId,
            code: check.code,
            description: check.description,
          };
        }

        const amount = Math.max(
          0,
          itemsTotal +
            deliveryFeePaise +
            convenienceFeePaise -
            discount -
            couponDiscount,
        );

        const first = lines[0]!;
        const { restaurantLat, restaurantLng, deliveryLat, deliveryLng } =
          simulateDeliveryCoords(first.dishId);

        // One step: the code is claimed with the order or not at all.
        const order = await createOrderClaimingCoupon(
          coupon
            ? { couponId: coupon.couponId, userId: req.userId!, discountPaise: couponDiscount }
            : null,
          (tx) => tx.order.create({
          data: {
            userId: req.userId!,
            ...(fingerprint ? { requestKey: fingerprint } : {}),
            domain: "food",
            status: "pending_payment",
            provider: first.platform,
            fulfillment: "in_app",
            title:
              lines.length > 1
                ? `${first.name} + ${lines.length - 1} more, ${first.restaurant}`
                : `${first.name} at ${first.restaurant}`,
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
              coupon: coupon
                ? { code: coupon.code, discountPaise: couponDiscount }
                : undefined,
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
            // A promo code is money the buyer kept, so it counts as savings.
            savedPaise: savedPaise + couponDiscount,
            addressId: defaultAddress?.id ?? null,
          },
        }),
        );
        void emitOrderDiscovery(order);
        // Pair each line that came from a recommendation with the ranking that
        // produced it. The key is built here from the line being ordered, not
        // taken from the caller, so nothing can plant a choice that was never
        // made. Deduplicated by decision: a row records one chosen option, so
        // two lines from the same ranking would otherwise race to be it.
        const paired = new Set<string>();
        for (const item of body.items) {
          if (!item.decisionId || paired.has(item.decisionId)) continue;
          paired.add(item.decisionId);
          void recordSelection({
            decisionId: item.decisionId,
            selectedKey: `${item.dishId}@${item.platform}`,
            orderId: order.id,
            userId: req.userId!,
          });
        }
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

        const defaultAddress = await requireDeliveryAddress(req.userId!);

        // Flouna Plus perk: in-app convenience fee is waived for subscribers.
        const me = await prisma.user.findUniqueOrThrow({
          where: { id: req.userId! },
          select: { plusActive: true, plusUntil: true },
        });
        const convenienceFeePaise =
          quote.fulfillment === "in_app" && !isPlusActive(me)
            ? CONVENIENCE_FEE_PAISE
            : 0;

        // Promo code — re-evaluated server-side against the dish price.
        let couponDiscount = 0;
        let coupon: { couponId: string; code: string; description: string } | null = null;
        if (body.couponCode) {
          const check = await evaluateCoupon({
            code: body.couponCode,
            userId: req.userId!,
            domain: "food",
            subtotalPaise: quote.effectivePaise,
          });
          if (!check.ok) throw new ApiError(400, check.reason);
          couponDiscount = check.discountPaise;
          coupon = {
            couponId: check.couponId,
            code: check.code,
            description: check.description,
          };
        }

        // Restaurant → delivery coordinates power the live delivery map on the
        // order screen. Simulated near a city centre for now (a short, realistic
        // route); real ONDC restaurant + address coordinates replace these.
        const { restaurantLat, restaurantLng, deliveryLat, deliveryLng } =
          simulateDeliveryCoords(body.dishId);

        // One step: the code is claimed with the order or not at all.
        const order = await createOrderClaimingCoupon(
          coupon
            ? { couponId: coupon.couponId, userId: req.userId!, discountPaise: couponDiscount }
            : null,
          (tx) => tx.order.create({
          data: {
            userId: req.userId!,
            ...(fingerprint ? { requestKey: fingerprint } : {}),
            domain: "food",
            status: "pending_payment",
            provider: quote.platform,
            fulfillment: quote.fulfillment,
            title: `${quote.name} at ${quote.restaurant}`,
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
              coupon: coupon
                ? { code: coupon.code, discountPaise: couponDiscount }
                : undefined,
            }),
            amount: Math.max(
              0,
              quote.effectivePaise + convenienceFeePaise - couponDiscount,
            ),
            savedPaise: savedPaise + couponDiscount,
            addressId: defaultAddress?.id ?? null,
          },
        }),
        );
        // Record the simulated ONDC discovery flow (search/select) for the
        // developer transaction viewer. Fire-and-forget — never blocks the order.
        void emitOrderDiscovery(order);
        if (body.decisionId) {
          void recordSelection({
            decisionId: body.decisionId,
            // The trace's key space for food: which dish, on which listing.
            selectedKey: `${body.dishId}@${body.platform}`,
            orderId: order.id,
            userId: req.userId!,
          });
        }
        return res.status(201).json({ order });
      }

      if (body.domain === "shop") {
        const allQuotes = quotesForProduct(body.productId);
        const quote = allQuotes.find((q) => q.platform === body.platform);
        if (!quote) throw new ApiError(404, "That product option is no longer available");

        const cheapestOther = Math.min(
          ...allQuotes
            .filter((q) => q.platform !== body.platform)
            .map((q) => q.effectivePaise),
        );
        const savedPaise = Number.isFinite(cheapestOther)
          ? Math.max(0, cheapestOther - quote.effectivePaise)
          : 0;

        const defaultAddress = await requireDeliveryAddress(req.userId!);

        const me = await prisma.user.findUniqueOrThrow({
          where: { id: req.userId! },
          select: { plusActive: true, plusUntil: true },
        });
        const convenienceFeePaise = !isPlusActive(me) ? CONVENIENCE_FEE_PAISE : 0;

        let couponDiscount = 0;
        let coupon: { couponId: string; code: string; description: string } | null = null;
        if (body.couponCode) {
          const check = await evaluateCoupon({
            code: body.couponCode,
            userId: req.userId!,
            domain: "shop",
            subtotalPaise: quote.effectivePaise,
          });
          if (!check.ok) throw new ApiError(400, check.reason);
          couponDiscount = check.discountPaise;
          coupon = {
            couponId: check.couponId,
            code: check.code,
            description: check.description,
          };
        }

        // One step: the code is claimed with the order or not at all.
        const order = await createOrderClaimingCoupon(
          coupon
            ? { couponId: coupon.couponId, userId: req.userId!, discountPaise: couponDiscount }
            : null,
          (tx) => tx.order.create({
          data: {
            userId: req.userId!,
            ...(fingerprint ? { requestKey: fingerprint } : {}),
            domain: "shop",
            status: "pending_payment",
            provider: quote.platform,
            fulfillment: "in_app",
            title: `${quote.name} from ${quote.brand}`,
            details: JSON.stringify({
              ...quote,
              convenienceFeePaise,
              comparedOptions: allQuotes.length,
              comparedPlatforms: new Set(allQuotes.map((q) => q.platform)).size,
              coupon: coupon
                ? { code: coupon.code, discountPaise: couponDiscount }
                : undefined,
            }),
            amount: Math.max(
              0,
              quote.effectivePaise + convenienceFeePaise - couponDiscount,
            ),
            savedPaise: savedPaise + couponDiscount,
            addressId: defaultAddress?.id ?? null,
          },
        }),
        );
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
        env.GOOGLE_MAPS_API_KEY,
      );
      const { distanceKm, rideMinutes } = route;
      const quotes = quoteRides({ distanceKm, rideMinutes });
      const quote = quotes.find(
        (q) => q.provider === body.provider && q.productName === body.productName,
      );
      if (!quote) throw new ApiError(404, "That ride option is no longer available");
      if (body.expectedPaise !== undefined && body.expectedPaise !== quote.effectivePaise) {
        throw new ApiError(
          409,
          `The fare has changed to ₹${Math.round(quote.effectivePaise / 100)}. Review it and book again.`,
        );
      }

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
          ...(fingerprint ? { requestKey: fingerprint } : {}),
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
      if (body.decisionId) {
        // Rides are keyed by product name in the trace.
        void recordSelection({
          decisionId: body.decisionId,
          selectedKey: body.productName,
          orderId: order.id,
          userId: req.userId!,
        });
      }
      res.status(201).json({ order });
    } catch (err) {
      // Two identical requests in flight together both pass the check above
      // and both try to insert. The unique index stops the second, which is
      // the outcome that matters, but the loser was being handed a 500 for a
      // request that had in fact succeeded once. Give it the order that won.
      if (fingerprint && (err as { code?: string }).code === "P2002") {
        const existing = await prisma.order
          .findFirst({
            where: { userId: req.userId!, requestKey: fingerprint },
            orderBy: { createdAt: "desc" },
          })
          .catch(() => null);
        if (existing) {
          res.status(200).json({ order: existing, deduplicated: true });
          return;
        }
      }
      next(err);
    }
  },
);

// What a cart will cost, before committing to it.
//
// The screen cannot work this out for itself: one delivery fee for the order,
// each listing's offer once, and whether the convenience fee applies at all
// are all properties of the order rather than of a line, and the last one
// depends on the customer's subscription. It used to try, and at quantity two
// it promised a total nobody was going to charge. This answers with the same
// function the order is priced by.
ordersRouter.post(
  "/preview",
  validateBody(
    z
      .object({
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
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const { items } = req.body as { items: CartItem[] };
      const me = await prisma.user.findUniqueOrThrow({
        where: { id: req.userId! },
        select: { plusActive: true, plusUntil: true },
      });
      const bill = priceFoodCart(items, {
        convenienceFeePaise: !isPlusActive(me) ? CONVENIENCE_FEE_PAISE : 0,
      });
      // A promo code is deliberately not applied here: the cart validates one
      // through the coupons route, which is where a code is checked against
      // the customer and their history.
      res.json({ bill });
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
        ...(domain === "food" || domain === "ride" || domain === "shop" ? { domain } : {}),
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
        rating: { select: { stars: true, comment: true } },
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
      // Only if it is still confirmed. This write used to be unconditional,
      // so a cancellation landing between the read above and this line was
      // overwritten: the order showed completed with a refund flagged against
      // it and cashback paid on it.
      const completed = await prisma.order.updateMany({
        where: { id: order.id, status: "confirmed" },
        data: { status: "completed" },
      });
      if (completed.count === 0) {
        // Something else changed it first; show what it is now.
        const current = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        return res.json({ order: { ...order, ...current, details: JSON.parse(current.details) } });
      }
      order = { ...order, status: "completed" };

      // Completing the order is what earns the buyer's cashback. The rate is
      // the platform's own configured numbers — the ONDC margin floor, and the
      // share of it handed back — so nothing about the reward is invented here.
      // The ledger's unique index makes a repeat call a no-op, which matters
      // because this route is polled.
      const { ondcMinMarginBps, cashbackUserSharePct } = await getConfig();
      if (cashbackUserSharePct > 0) {
        await creditCashback({
          userId: order.userId,
          orderId: order.id,
          marginPaise: Math.floor((order.amount * ondcMinMarginBps) / 10_000),
          title: order.title,
        }).catch(() => {
          // A reward must never break the order it rewards.
        });
      }
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
/**
 * The conversation with the driver of one ride.
 *
 * The rider's messages are real and kept. The driver's are produced from the
 * states the ride has actually reached, by the same simulation that invents
 * the driver's name and plate, and are flagged so the screen can keep saying
 * so. A rider must never be unable to tell which of the two they are reading.
 */
ordersRouter.get("/:id/messages", async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      include: { trackingEvents: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!order) throw new ApiError(404, "Order not found");
    if (order.domain !== "ride") throw new ApiError(400, "This order has no driver");
    if (order.status === "pending_payment")
      throw new ApiError(409, "Ride not confirmed yet");

    // Bring the driver's side up to whatever the ride has reached, then read
    // the whole thread back in one order.
    if (order.status !== "cancelled") {
      const d = JSON.parse(order.details) as {
        pickupLat?: number; pickupLng?: number;
        dropLat?: number; dropLng?: number;
        vehicle?: "bike" | "auto" | "cab";
        routeGeometry?: [number, number][];
      };
      if (d.pickupLat != null && d.pickupLng != null && d.dropLat != null && d.dropLng != null) {
        const bookedAt = order.trackingEvents[0]?.createdAt ?? order.createdAt;
        if (bookedAt.getTime() <= Date.now()) {
          const assignment = await rideProvider.track({
            orderId: order.id,
            providerRef: `SIM-${order.id.slice(0, 8).toUpperCase()}`,
            vehicle: d.vehicle ?? "cab",
            pickup: { lat: d.pickupLat, lng: d.pickupLng },
            drop: { lat: d.dropLat, lng: d.dropLng },
            routeGeometry:
              d.routeGeometry ?? ([[d.pickupLng, d.pickupLat], [d.dropLng, d.dropLat]] as [number, number][]),
            bookedAt,
            domain: "ride",
          });
          await catchUpDriverMessages({
            orderId: order.id,
            state: assignment.state,
            etaMinutes: assignment.pickupEtaMinutes,
            plate: assignment.driver?.vehicle.plate ?? null,
          });
        }
      }
    }

    const messages = await prisma.rideMessage.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, sender: true, body: true, simulated: true, createdAt: true },
    });
    res.json({ messages, simulated: rideProvider.mode === "simulation" });
  } catch (err) {
    next(err);
  }
});

ordersRouter.post(
  "/:id/messages",
  validateBody(z.object({ body: z.string().trim().min(1).max(500) }).strict()),
  async (req, res, next) => {
    try {
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, userId: req.userId! },
        select: { id: true, domain: true, status: true },
      });
      if (!order) throw new ApiError(404, "Order not found");
      if (order.domain !== "ride") throw new ApiError(400, "This order has no driver");
      if (order.status === "pending_payment")
        throw new ApiError(409, "Ride not confirmed yet");
      // A finished or cancelled ride keeps its transcript readable but takes
      // no new messages: there is nobody on the other end any more.
      if (order.status === "completed" || order.status === "cancelled")
        throw new ApiError(409, "This ride has ended");

      const message = await prisma.rideMessage.create({
        data: {
          orderId: order.id,
          sender: "rider",
          body: (req.body as { body: string }).body,
          simulated: false,
        },
        select: { id: true, sender: true, body: true, simulated: true, createdAt: true },
      });
      res.status(201).json({ message });
    } catch (err) {
      next(err);
    }
  },
);

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
      const when = istTimeLabel(bookedAt);
      return res.json({
        tracking: {
          providerRef: `SIM-${order.id.slice(0, 8).toUpperCase()}`,
          state: "searching",
          otp: "----",
          driver: null,
          driverLocation: null,
          pickupEtaMinutes: Math.ceil((bookedAt.getTime() - Date.now()) / 60_000),
          dropEtaMinutes: 0,
          statusMessage: `Ride scheduled for ${when}, we'll find your captain then`,
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

    // A rider must be able to tell a simulated trip from a real one. When the
    // pilot flag is on, the driver, OTP and moving vehicle below are invented,
    // and the UI says so rather than letting them read as real.
    res.json({ tracking: assignment, simulated: rideProvider.mode === "simulation" });
  } catch (err) {
    next(err);
  }
});

// What the published refund policy says about this order, right now.
//
// Served rather than worked out in the client so the countdown the customer
// sees and the rule the server enforces are the same rule. A five minute
// window that the screen computes from its own clock is a window that
// disagrees with the server for anyone whose phone clock is off.
ordersRouter.get("/:id/cancellation", async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: req.userId! },
      include: { payment: true },
    });
    if (!order) throw new ApiError(404, "Order not found");
    const terms = cancellationTerms(order, order.payment);
    const [lo, hi] = refundWindowDays(order.payment?.method ?? null);
    res.json({ ...terms, refundDays: { min: lo, max: hi } });
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
    z.object({ reason: z.string().trim().max(200).optional() }).strict(),
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

      // Which side of the published window this fell on, decided here and
      // written down. Working it out later from timestamps would re-derive a
      // customer's entitlement from a clock that has since moved on, and the
      // answer has to be the one that was true at the moment they cancelled.
      const payment = await prisma.payment.findUnique({ where: { orderId: order.id } });
      const terms = cancellationTerms(order, payment);
      details.cancelledWithinFreeWindow = terms.freeWindow;
      details.cancelledAt = new Date().toISOString();

      // Only if it is still open. This write used to be unconditional, so an
      // order that completed between the checks above and here (food already
      // delivered) was cancelled anyway and its payment flagged for a refund.
      const cancelled = await prisma.order.updateMany({
        where: { id: order.id, status: { notIn: ["completed", "cancelled"] } },
        data: { status: "cancelled", details: JSON.stringify(details) },
      });
      if (cancelled.count === 0) {
        throw new ApiError(
          409,
          isFood ? "This order has just been delivered" : "This trip has just finished",
        );
      }
      const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

      // Reward credit spent on this order goes straight back — it never left
      // Flouna, so there is nothing to wait on a gateway for. Best-effort: the
      // ledger's unique index rejects a second refund for the same order, and
      // a cancellation must not fail because the credit was already returned.
      // Read from the ledger, not from the order's details. A payment with
      // credit landing at the same moment wrote its record into details after
      // this request had read them, and the copy written back above erased it,
      // so the credit was never returned. The ledger's debit is the fact.
      const spend = await prisma.walletEntry.findUnique({
        where: {
          userId_orderId_reason: { userId: order.userId, orderId: order.id, reason: "spend" },
        },
        select: { amountPaise: true },
      });
      const walletApplied = spend ? -spend.amountPaise : 0;
      if (walletApplied > 0) {
        await refundToWallet({
          userId: order.userId,
          orderId: order.id,
          amountPaise: walletApplied,
          description: `Returned from ${order.title}`,
        }).catch(() => {});
      }

      // Money already taken? Cancelling has to start the refund, not just mark
      // the order dead — the tracker promises "refund will be processed", and
      // ops would otherwise never learn money is owed back. Status-scoped so a
      // payment that isn't actually settled is left alone (cash on delivery
      // sits at "pending" — nothing to return).
      //
      // Only money that went through the gateway is owed back through it. An
      // order the wallet covered in full has a zero rupee payment: its credit
      // was returned just above, so that payment is simply closed. Flagging it
      // used to tell the customer a refund was coming that they already had,
      // and gave ops a queue item asking Cashfree to refund nothing on an
      // order it never saw, which failed every time and could not be cleared.
      const refundFlagged = await prisma.payment.updateMany({
        where: { orderId: order.id, status: "success", amount: { gt: 0 } },
        data: { status: "refund_pending" },
      });
      await prisma.payment.updateMany({
        where: { orderId: order.id, status: "success", amount: 0 },
        data: { status: "refunded" },
      });

      void sendPushToUser(order.userId, {
        title: isFood ? "Order cancelled" : "Ride cancelled",
        body: `${order.title} was cancelled.`,
        url: `/orders/${order.id}`,
      });
      // Email confirmation of the cancellation + refund status (outbox-gated).
      // Awaited (one cheap insert) but never allowed to fail the cancellation.
      await enqueueNotification(
        order.userId,
        "orders.cancelled",
        { title: order.title, orderId: order.id, ...(reason ? { reason } : {}) },
        { dedupeKey: `cancelled:${order.id}` },
      ).catch(() => {});

      res.json({
        order: { ...updated, details: JSON.parse(updated.details) },
        // Lets the UI say "refund on its way" only when one is actually owed.
        refundPending: refundFlagged.count > 0,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- rate a completed order ----------
//
// Ratings only make sense once the thing actually happened, so this is gated on
// a completed order the caller owns, and can only be left once. The stars feed
// back into recommendation scoring via the community-rating blend.
ordersRouter.post(
  "/:id/rate",
  validateBody(
    z.object({
      stars: z.number().int().min(1).max(5),
      comment: z.string().trim().max(300).optional(),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { stars, comment } = req.body as { stars: number; comment?: string };
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, userId: req.userId! },
        include: { rating: true },
      });
      if (!order) throw new ApiError(404, "Order not found");
      if (order.status !== "completed") {
        throw new ApiError(
          409,
          order.domain === "food"
            ? "You can rate this once it's delivered"
            : "You can rate this once the trip is finished",
        );
      }
      if (order.rating) throw new ApiError(409, "You've already rated this order");

      // What was rated: the dish for food, the provider for a ride.
      const details = JSON.parse(order.details) as { dishId?: string };
      const itemKey =
        order.domain === "food" ? (details.dishId ?? order.provider) : order.provider;

      const rating = await prisma.orderRating
        .create({
          data: {
            orderId: order.id,
            userId: req.userId!,
            domain: order.domain,
            itemKey,
            stars,
            comment: comment || null,
          },
        })
        .catch((err: { code?: string }) => {
          // A second submission at the same moment passed the check above and
          // hit the one-rating-per-order index. It is the same answer, not a
          // server fault, and a 500 here put a false alarm in the error log.
          if (err?.code === "P2002") throw new ApiError(409, "You've already rated this order");
          throw err;
        });
      res.status(201).json({ rating });
    } catch (err) {
      next(err);
    }
  },
);
