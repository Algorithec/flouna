import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { quotesForDish } from "../food/food.service.js";
import { quoteRides, fetchRoute } from "../rides/rides.service.js";
import { env } from "../../config/env.js";
import { sendPushToUser } from "../notifications/push.service.js";
import { joinLimiter } from "../../middleware/rateLimit.js";

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

// Short, unambiguous join code (no 0/O/1/I).
function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) code += alphabet[bytes[i]! % alphabet.length];
  return code;
}

type CartWithItems = {
  id: string;
  code: string;
  hostId: string;
  domain: string;
  platform: string;
  rideDetails: string | null;
  status: string;
  orderId: string | null;
  items: {
    id: string;
    userId: string;
    dishId: string;
    name: string;
    pricePaise: number;
    qty: number;
    user: { name: string };
  }[];
  members: { userId: string; user: { name: string } }[];
};

// The trip snapshot stored on ride carts — display copy plus the coordinates
// the checkout recomputes the authoritative fare from.
type RideSnapshot = {
  pickup: string;
  drop: string;
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  provider: string;
  productName: string;
  displayName: string;
  vehicle: string;
  farePaise: number;
  seats: number;
};

// How many people can actually share the vehicle (driver excluded).
const SEATS: Record<string, number> = { auto: 3, cab: 4 };

// Builds the per-member breakdown + split shown to everyone. Food carts split
// by what each member added; ride carts split the fare equally.
async function summarize(cartId: string, viewerId: string) {
  const cart = (await prisma.groupCart.findUnique({
    where: { id: cartId },
    include: {
      items: { include: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
      members: { include: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
    },
  })) as CartWithItems | null;
  if (!cart) throw new ApiError(404, "Group order not found");

  const base = {
    id: cart.id,
    code: cart.code,
    domain: cart.domain,
    platform: cart.platform,
    status: cart.status,
    orderId: cart.orderId,
    isHost: cart.hostId === viewerId,
  };

  if (cart.domain === "ride") {
    const ride = JSON.parse(cart.rideDetails ?? "{}") as RideSnapshot;
    const memberCount = Math.max(1, cart.members.length);
    const equalSplitPaise = Math.round(ride.farePaise / memberCount);
    return {
      ...base,
      ride: {
        pickup: ride.pickup,
        drop: ride.drop,
        displayName: ride.displayName,
        vehicle: ride.vehicle,
        seats: ride.seats,
      },
      totalPaise: ride.farePaise,
      equalSplitPaise,
      members: cart.members.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        subtotalPaise: equalSplitPaise,
        isYou: m.userId === viewerId,
      })),
      items: [],
    };
  }

  const members = new Map<string, { name: string; subtotalPaise: number }>();
  for (const item of cart.items) {
    const cur = members.get(item.userId) ?? { name: item.user.name, subtotalPaise: 0 };
    cur.subtotalPaise += item.pricePaise * item.qty;
    members.set(item.userId, cur);
  }
  const totalPaise = cart.items.reduce((s, i) => s + i.pricePaise * i.qty, 0);
  const memberCount = Math.max(1, members.size);
  const equalSplitPaise = Math.round(totalPaise / memberCount);

  return {
    ...base,
    ride: null,
    totalPaise,
    equalSplitPaise,
    members: [...members.entries()].map(([userId, m]) => ({
      userId,
      name: m.name,
      subtotalPaise: m.subtotalPaise,
      isYou: userId === viewerId,
    })),
    items: cart.items.map((i) => ({
      id: i.id,
      userId: i.userId,
      memberName: i.user.name,
      dishId: i.dishId,
      name: i.name,
      pricePaise: i.pricePaise,
      qty: i.qty,
      isYou: i.userId === viewerId,
    })),
  };
}

// Membership = host OR explicit GroupCartMember row (created on join).
async function assertMember(cartId: string, userId: string) {
  const cart = await prisma.groupCart.findUnique({ where: { id: cartId } });
  if (!cart) throw new ApiError(404, "Group order not found");
  if (cart.hostId === userId) return cart;
  const member = await prisma.groupCartMember.findUnique({
    where: { cartId_userId: { cartId, userId } },
  });
  if (!member) throw new ApiError(403, "Join this group order first");
  return cart;
}

// Idempotently record a user as a member of a cart.
async function addMember(cartId: string, userId: string) {
  await prisma.groupCartMember.upsert({
    where: { cartId_userId: { cartId, userId } },
    create: { cartId, userId },
    update: {},
  });
}

// ---------- create ----------
const createFoodGroup = z.object({
  domain: z.literal("food").default("food"),
  platform: z.enum(["ondc", "swiggy", "zomato"]),
});
const createRideGroup = z.object({
  domain: z.literal("ride"),
  ride: z.object({
    provider: z.enum(["uber", "ola", "rapido", "ondc"]),
    productName: z.string().max(60),
    pickup: z.string().max(160),
    drop: z.string().max(160),
    pickupLat: z.number().min(-90).max(90),
    pickupLng: z.number().min(-180).max(180),
    dropLat: z.number().min(-90).max(90),
    dropLng: z.number().min(-180).max(180),
  }),
});

groupsRouter.post(
  "/",
  validateBody(z.union([createRideGroup, createFoodGroup])),
  async (req, res, next) => {
    try {
      const body = req.body as
        | z.infer<typeof createFoodGroup>
        | z.infer<typeof createRideGroup>;

      let platform: string;
      let rideDetails: string | null = null;
      if (body.domain === "ride") {
        // Snapshot the trip server-side — fare from our engine, never the client.
        const route = await fetchRoute(
          body.ride.pickupLat,
          body.ride.pickupLng,
          body.ride.dropLat,
          body.ride.dropLng,
          env.ORS_KEY,
        );
        const quote = quoteRides({
          distanceKm: route.distanceKm,
          rideMinutes: route.rideMinutes,
        }).find(
          (q) =>
            q.provider === body.ride.provider &&
            q.productName === body.ride.productName,
        );
        if (!quote) throw new ApiError(404, "That ride option is no longer available");
        const seats = SEATS[quote.vehicle];
        if (!seats) {
          throw new ApiError(400, "Only autos and cabs can be shared");
        }
        platform = quote.provider;
        rideDetails = JSON.stringify({
          pickup: body.ride.pickup,
          drop: body.ride.drop,
          pickupLat: body.ride.pickupLat,
          pickupLng: body.ride.pickupLng,
          dropLat: body.ride.dropLat,
          dropLng: body.ride.dropLng,
          provider: quote.provider,
          productName: quote.productName,
          displayName: quote.displayName,
          vehicle: quote.vehicle,
          farePaise: quote.effectivePaise,
          seats,
        } satisfies RideSnapshot);
      } else {
        platform = body.platform;
      }

      // Retry on the rare code collision.
      let cart;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          cart = await prisma.groupCart.create({
            data: {
              code: generateCode(),
              hostId: req.userId!,
              domain: body.domain,
              platform,
              rideDetails,
            },
          });
          break;
        } catch {
          /* unique collision — try a new code */
        }
      }
      if (!cart) throw new ApiError(500, "Could not create group order");
      await addMember(cart.id, req.userId!); // host is a member
      res.status(201).json(await summarize(cart.id, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

// ---------- join by code ----------
groupsRouter.post(
  "/join",
  joinLimiter,
  validateBody(z.object({ code: z.string().trim().toUpperCase().length(6) })),
  async (req, res, next) => {
    try {
      const { code } = req.body as { code: string };
      const cart = await prisma.groupCart.findUnique({
        where: { code },
        include: { members: { select: { userId: true } } },
      });
      if (!cart) throw new ApiError(404, "No group order with that code");
      if (cart.status !== "open") {
        throw new ApiError(409, "This group order is closed");
      }
      // Shared rides have physical seats — don't let a 5th person into a cab.
      if (cart.domain === "ride") {
        const ride = JSON.parse(cart.rideDetails ?? "{}") as RideSnapshot;
        const alreadyIn = cart.members.some((m) => m.userId === req.userId!);
        if (!alreadyIn && cart.members.length >= ride.seats) {
          throw new ApiError(409, "This ride is full");
        }
      }
      await addMember(cart.id, req.userId!); // joining establishes membership
      res.json(await summarize(cart.id, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

// ---------- view ----------
// Only the host or a participating member may read the cart (H1: blocks
// reading arbitrary carts by ID — members' names and items are private).
groupsRouter.get("/:id", async (req, res, next) => {
  try {
    await assertMember(req.params.id!, req.userId!);
    res.json(await summarize(req.params.id, req.userId!));
  } catch (err) {
    next(err);
  }
});

// ---------- add item ----------
groupsRouter.post(
  "/:id/items",
  validateBody(
    z.object({ dishId: z.string().max(60), qty: z.number().int().min(1).max(20).default(1) }),
  ),
  async (req, res, next) => {
    try {
      const { dishId, qty } = req.body as { dishId: string; qty: number };
      // H2: only members (host or someone who joined via code) may add items.
      const cart = await assertMember(req.params.id!, req.userId!);
      if (cart.domain === "ride") {
        throw new ApiError(400, "This is a shared ride — there's nothing to add");
      }
      if (cart.status !== "open") throw new ApiError(409, "This group order is closed");

      // Price comes from the cart's platform — server-trusted, never the client.
      const quote = quotesForDish(dishId).find((q) => q.platform === cart.platform);
      if (!quote) throw new ApiError(404, "That dish isn't available on this platform");

      await prisma.groupCartItem.create({
        data: {
          cartId: cart.id,
          userId: req.userId!,
          dishId,
          name: quote.name,
          pricePaise: quote.effectivePaise,
          qty,
        },
      });

      // Let the host know someone added to the order.
      if (cart.hostId !== req.userId!) {
        void sendPushToUser(cart.hostId, {
          title: "Someone joined your group order 🍴",
          body: `${quote.name} was added.`,
          url: `/food/group/${cart.id}`,
        });
      }
      res.status(201).json(await summarize(cart.id, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

// ---------- remove own item ----------
groupsRouter.delete("/:id/items/:itemId", async (req, res, next) => {
  try {
    await assertMember(req.params.id!, req.userId!);
    // You can only remove your own items.
    const deleted = await prisma.groupCartItem.deleteMany({
      where: { id: req.params.itemId, cartId: req.params.id, userId: req.userId! },
    });
    if (deleted.count === 0) throw new ApiError(404, "Item not found");
    res.json(await summarize(req.params.id, req.userId!));
  } catch (err) {
    next(err);
  }
});

// Builds a UPI deep link (upi://pay) that opens any UPI app pre-filled with
// the payee, amount, and a note. The standard, integration-free way to collect
// a friend's share in India.
function upiLink(opts: {
  payeeUpi: string;
  payeeName: string;
  amountPaise: number;
  note: string;
}): string {
  const params = new URLSearchParams({
    pa: opts.payeeUpi,
    pn: opts.payeeName,
    am: (opts.amountPaise / 100).toFixed(2),
    cu: "INR",
    tn: opts.note,
  });
  return `upi://pay?${params.toString()}`;
}

const VALID_UPI = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/;

// ---------- host places the combined order ----------
// H3 (Option C): the host pays the full bill now; the response includes each
// member's share — by what they actually ordered — plus a UPI link the host
// shares so friends settle their portion.
groupsRouter.post(
  "/:id/checkout",
  validateBody(
    z.object({
      // Optional: the host's UPI ID to collect shares into. If omitted, the
      // breakdown is returned without payable links.
      hostUpiId: z
        .string()
        .trim()
        .regex(VALID_UPI, "Enter a valid UPI ID, e.g. name@bank")
        .optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      const { hostUpiId } = req.body as { hostUpiId?: string };
      const cart = await prisma.groupCart.findUnique({
        where: { id: req.params.id },
        include: {
          items: { include: { user: { select: { id: true, name: true } } } },
          members: { include: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
        },
      });
      if (!cart) throw new ApiError(404, "Group order not found");
      if (cart.hostId !== req.userId!) {
        throw new ApiError(403, "Only the host can place the order");
      }
      if (cart.status !== "open") throw new ApiError(409, "Already checked out");

      // ---------- shared ride: equal split, one trackable ride order ----------
      if (cart.domain === "ride") {
        const ride = JSON.parse(cart.rideDetails ?? "{}") as RideSnapshot;
        // Recompute the authoritative fare from coordinates at booking time —
        // the snapshot fare is a display estimate only.
        const route = await fetchRoute(
          ride.pickupLat,
          ride.pickupLng,
          ride.dropLat,
          ride.dropLng,
          env.ORS_KEY,
        );
        const quotes = quoteRides({
          distanceKm: route.distanceKm,
          rideMinutes: route.rideMinutes,
        });
        const quote = quotes.find(
          (q) => q.provider === ride.provider && q.productName === ride.productName,
        );
        if (!quote) throw new ApiError(404, "That ride option is no longer available");

        const hostName =
          cart.members.find((m) => m.userId === cart.hostId)?.user.name ?? "Host";
        const memberCount = Math.max(1, cart.members.length);
        const sharePaise = Math.round(quote.effectivePaise / memberCount);
        const shares = cart.members.map((m) => ({
          userId: m.userId,
          name: m.user.name,
          sharePaise,
          isHost: m.userId === cart.hostId,
          upiLink:
            m.userId === cart.hostId || !hostUpiId
              ? null
              : upiLink({
                  payeeUpi: hostUpiId,
                  payeeName: hostName,
                  amountPaise: sharePaise,
                  note: `Shared ride (${m.user.name})`,
                }),
        }));

        const order = await prisma.order.create({
          data: {
            userId: req.userId!,
            domain: "ride",
            status: "pending_payment",
            provider: quote.provider,
            fulfillment: quote.fulfillment,
            title: `${quote.displayName}: ${ride.pickup} → ${ride.drop} · ${memberCount} riders`,
            details: JSON.stringify({
              ...quote,
              pickup: ride.pickup,
              drop: ride.drop,
              pickupLat: ride.pickupLat,
              pickupLng: ride.pickupLng,
              dropLat: ride.dropLat,
              dropLng: ride.dropLng,
              distanceKm: route.distanceKm,
              vehicle: quote.vehicle,
              routeGeometry: route.geometry,
              comparedOptions: quotes.length,
              comparedPlatforms: new Set(quotes.map((q) => q.provider)).size,
              group: true,
              memberCount,
              shares: shares.map((s) => ({
                name: s.name,
                sharePaise: s.sharePaise,
                isHost: s.isHost,
              })),
            }),
            amount: quote.effectivePaise,
          },
        });

        await prisma.groupCart.update({
          where: { id: cart.id },
          data: { status: "ordered", orderId: order.id },
        });

        // Everyone in the ride learns it's booked (host is on the pay screen).
        for (const m of cart.members) {
          if (m.userId === cart.hostId) continue;
          void sendPushToUser(m.userId, {
            title: "Your shared ride is booked 🚕",
            body: `${quote.displayName} to ${ride.drop} — your share is ₹${(sharePaise / 100).toFixed(0)}.`,
            url: `/rides/group/${cart.id}`,
          });
        }

        return res.json({ orderId: order.id, totalPaise: quote.effectivePaise, shares });
      }

      if (cart.items.length === 0) throw new ApiError(400, "The cart is empty");

      const totalPaise = cart.items.reduce((s, i) => s + i.pricePaise * i.qty, 0);

      // Each member owes for what THEY added (fairer than a flat equal split).
      const owed = new Map<string, { name: string; sharePaise: number }>();
      for (const item of cart.items) {
        const cur = owed.get(item.userId) ?? { name: item.user.name, sharePaise: 0 };
        cur.sharePaise += item.pricePaise * item.qty;
        owed.set(item.userId, cur);
      }
      const hostName =
        owed.get(cart.hostId)?.name ?? cart.items[0]?.user.name ?? "Host";

      const shares = [...owed.entries()].map(([userId, m]) => ({
        userId,
        name: m.name,
        sharePaise: m.sharePaise,
        isHost: userId === cart.hostId,
        // Host doesn't pay themselves; others get a UPI link if host gave an ID.
        upiLink:
          userId === cart.hostId || !hostUpiId
            ? null
            : upiLink({
                payeeUpi: hostUpiId,
                payeeName: hostName,
                amountPaise: m.sharePaise,
                note: `Group order share (${m.name})`,
              }),
      }));

      const order = await prisma.order.create({
        data: {
          userId: req.userId!,
          domain: "food",
          status: "pending_payment",
          provider: cart.platform,
          fulfillment: "in_app",
          title: `Group order · ${cart.items.length} items · ${owed.size} people`,
          details: JSON.stringify({
            group: true,
            memberCount: owed.size,
            items: cart.items.map((i) => ({
              name: i.name,
              qty: i.qty,
              pricePaise: i.pricePaise,
            })),
            shares: shares.map((s) => ({
              name: s.name,
              sharePaise: s.sharePaise,
              isHost: s.isHost,
            })),
            comparedOptions: 0,
          }),
          amount: totalPaise,
        },
      });

      await prisma.groupCart.update({
        where: { id: cart.id },
        data: { status: "ordered", orderId: order.id },
      });

      res.json({ orderId: order.id, totalPaise, shares });
    } catch (err) {
      next(err);
    }
  },
);
