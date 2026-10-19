import crypto from "node:crypto";
import { splitFare, rupeesExact } from "./split.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { CONTENDED_TX, withTxRetry } from "../../lib/txRetry.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { quotesForDish } from "../food/food.service.js";
import { quoteRides, fetchRoute } from "../rides/rides.service.js";
import { env } from "../../config/env.js";
import { sendPushToUser } from "../notifications/push.service.js";
import { joinLimiter } from "../../middleware/rateLimit.js";
import { groupChatRouter } from "./chat.routes.js";
import { suggestForCart } from "./suggestion.service.js";
import { privacyView } from "./privacy.js";

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

// Encrypted chat for one cart. Mounted here so it inherits :id and the same
// membership rules that guard the cart itself.
groupsRouter.use("/:id/chat", groupChatRouter);

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
  name: string | null;
  emoji: string | null;
  crewId: string | null;
  expectedMembers: number | null;
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
    name: cart.name,
    emoji: cart.emoji,
    crewId: cart.crewId,
    expectedMembers: cart.expectedMembers ?? null,
    orderId: cart.orderId,
    hostId: cart.hostId,
    isHost: cart.hostId === viewerId,
  };

  if (cart.domain === "ride") {
    const ride = JSON.parse(cart.rideDetails ?? "{}") as RideSnapshot;
    const memberCount = Math.max(1, cart.members.length);
    const split = splitFare(ride.farePaise, memberCount);
    // What each friend owes. The host's own line carries the remainder, so
    // the lines on screen add up to the fare.
    const equalSplitPaise = split.otherPaise;
    const view = await privacyView(
      viewerId,
      cart.members.map((m) => m.userId),
      cart.id,
    );
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
        name: view.nameFor(m.userId, m.user.name),
        active: view.activeFor(m.userId),
        subtotalPaise: m.userId === cart.hostId ? split.hostPaise : split.otherPaise,
        hasOrdered: true, // a seat in the cab is the order
        isHost: m.userId === cart.hostId,
        isYou: m.userId === viewerId,
      })),
      items: [],
    };
  }

  // Seed with everyone who has joined, so a member who has not ordered yet is
  // still on the list — the design shows them as "Waiting", and they cannot be
  // shown at all if the list is built from items alone.
  const members = new Map<string, { name: string; subtotalPaise: number }>();
  for (const m of cart.members) {
    members.set(m.userId, { name: m.user.name, subtotalPaise: 0 });
  }
  for (const item of cart.items) {
    const cur = members.get(item.userId) ?? { name: item.user.name, subtotalPaise: 0 };
    cur.subtotalPaise += item.pricePaise * item.qty;
    members.set(item.userId, cur);
  }
  const totalPaise = cart.items.reduce((s, i) => s + i.pricePaise * i.qty, 0);
  // Split across the people who actually ordered. Counting a member who has
  // not added anything would quietly bill them for everyone else's food.
  const ordering = new Set(cart.items.map((i) => i.userId));
  const equalSplitPaise = Math.round(totalPaise / Math.max(1, ordering.size));

  const view = await privacyView(
    viewerId,
    [...new Set([...members.keys(), ...cart.members.map((m) => m.userId)])],
    cart.id,
  );

  return {
    ...base,
    ride: null,
    totalPaise,
    equalSplitPaise,
    members: [...members.entries()].map(([userId, m]) => ({
      userId,
      name: view.nameFor(userId, m.name),
      active: view.activeFor(userId),
      subtotalPaise: m.subtotalPaise,
      // "Joined" on the status screen means they are in the room; ordering is
      // a separate thing, and conflating them would mislabel a member who is
      // still reading the menu.
      hasOrdered: m.subtotalPaise > 0,
      isHost: userId === cart.hostId,
      isYou: userId === viewerId,
    })),
    items: cart.items.map((i) => ({
      id: i.id,
      userId: i.userId,
      memberName: view.nameFor(i.userId, i.user.name),
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

/**
 * Adds a rider to a shared ride if a seat is free, counting and adding in one
 * step. Counting first and adding afterwards let two people joining for the
 * last seat both see it free and both get in: four in a three seat auto, and
 * the fare split four ways. Serializable, so Postgres refuses one of two
 * conflicting joins, and the refused one retries and finds the ride full.
 */
async function takeSeat(cartId: string, userId: string, seats: number) {
  try {
    await withTxRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const members = await tx.groupCartMember.findMany({
            where: { cartId },
            select: { userId: true },
          });
          if (members.some((m) => m.userId === userId)) return;
          if (members.length >= seats) throw new ApiError(409, "This ride is full");
          await tx.groupCartMember.create({ data: { cartId, userId } });
        },
        CONTENDED_TX,
      ),
    );
  } catch (err) {
    // Two joins by the same person at once: the other one already added them.
    if ((err as { code?: string }).code === "P2002") return;
    throw err;
  }
}

/**
 * Opens a group order with the host as its first member. Shared by the
 * create route and chat ("create a group order for four"), so both make the
 * same thing.
 */
export async function openGroupCart(o: {
  hostId: string;
  domain: "food" | "ride";
  platform: string;
  rideDetails?: string | null;
  expectedMembers?: number;
}) {
  // Retry on the rare code collision.
  let cart;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      cart = await prisma.groupCart.create({
        data: {
          code: generateCode(),
          hostId: o.hostId,
          domain: o.domain,
          platform: o.platform,
          rideDetails: o.rideDetails ?? null,
          expectedMembers: o.expectedMembers ?? null,
        },
      });
      break;
    } catch {
      /* unique collision — try a new code */
    }
  }
  if (!cart) throw new ApiError(500, "Could not create group order");
  await addMember(cart.id, o.hostId); // host is a member
  return summarize(cart.id, o.hostId);
}

/**
 * Adds a member's own dish to a food group order. The item is theirs alone:
 * nothing here copies it to anyone else. Shared by the route and chat.
 */
export async function addGroupItem(o: { cartId: string; userId: string; dishId: string; qty: number }) {
  // H2: only members (host or someone who joined via code) may add items.
  const cart = await assertMember(o.cartId, o.userId);
  if (cart.domain === "ride") {
    throw new ApiError(400, "This is a shared ride, there's nothing to add");
  }
  if (cart.status !== "open") throw new ApiError(409, "This group order is closed");

  // Price comes from the cart's platform — server-trusted, never the client.
  const quote = quotesForDish(o.dishId).find((q) => q.platform === cart.platform);
  if (!quote) throw new ApiError(404, "That dish isn't available on this platform");

  await prisma.groupCartItem.create({
    data: {
      cartId: cart.id,
      userId: o.userId,
      dishId: o.dishId,
      name: quote.name,
      pricePaise: quote.effectivePaise,
      qty: o.qty,
    },
  });

  // Let the host know someone added to the order.
  if (cart.hostId !== o.userId) {
    void sendPushToUser(cart.hostId, {
      title: "Someone joined your group order 🍴",
      body: `${quote.name} was added.`,
      url: `/food/group/${cart.id}`,
    });
  }
  return summarize(cart.id, o.userId);
}

/**
 * Opens a shared ride: the trip priced on the server from its coordinates,
 * never from the client, and only for vehicles with more than one seat.
 * Shared by the create route and chat ("one shared ride for all four").
 */
export async function openRideGroup(o: {
  hostId: string;
  provider: string;
  productName: string;
  pickup: string;
  drop: string;
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  expectedMembers?: number;
}) {
  // Snapshot the trip server-side — fare from our engine, never the client.
  const route = await fetchRoute(o.pickupLat, o.pickupLng, o.dropLat, o.dropLng, env.ORS_KEY, env.GOOGLE_MAPS_API_KEY);
  const quote = quoteRides({ distanceKm: route.distanceKm, rideMinutes: route.rideMinutes }).find(
    (q) => q.provider === o.provider && q.productName === o.productName,
  );
  if (!quote) throw new ApiError(404, "That ride option is no longer available");
  const seats = SEATS[quote.vehicle];
  if (!seats) throw new ApiError(400, "Only autos and cabs can be shared");
  if (o.expectedMembers && o.expectedMembers > seats) {
    throw new ApiError(400, `A ${quote.displayName} seats ${seats}, so it cannot take ${o.expectedMembers} people`);
  }
  const rideDetails = JSON.stringify({
    pickup: o.pickup,
    drop: o.drop,
    pickupLat: o.pickupLat,
    pickupLng: o.pickupLng,
    dropLat: o.dropLat,
    dropLng: o.dropLng,
    provider: quote.provider,
    productName: quote.productName,
    displayName: quote.displayName,
    vehicle: quote.vehicle,
    farePaise: quote.effectivePaise,
    seats,
  } satisfies RideSnapshot);
  return openGroupCart({ hostId: o.hostId, domain: "ride", platform: quote.provider, rideDetails, expectedMembers: o.expectedMembers });
}

export { summarize as groupSummary };

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

      if (body.domain === "ride") {
        return res.status(201).json(await openRideGroup({ hostId: req.userId!, ...body.ride }));
      }
      const platform = body.platform;
      const rideDetails: string | null = null;
      res.status(201).json(await openGroupCart({ hostId: req.userId!, domain: body.domain, platform, rideDetails }));
    } catch (err) {
      next(err);
    }
  },
);

// ---------- join by code ----------
groupsRouter.post(
  "/join",
  joinLimiter,
  validateBody(z.object({ code: z.string().trim().toUpperCase().length(6) }).strict()),
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
      // Blocking cuts both ways: the host can keep someone out, and someone who
      // blocked the host isn't quietly put back in a room with them. The reply
      // is the same "closed" either way, so a join attempt can't be used to
      // detect that you've been blocked.
      if (cart.hostId !== req.userId!) {
        const block = await prisma.blockedUser.findFirst({
          where: {
            OR: [
              { userId: cart.hostId, blockedUserId: req.userId! },
              { userId: req.userId!, blockedUserId: cart.hostId },
            ],
          },
          select: { id: true },
        });
        if (block) throw new ApiError(409, "This group order is closed");
      }
      // Shared rides have physical seats — don't let a 5th person into a cab.
      if (cart.domain === "ride") {
        const ride = JSON.parse(cart.rideDetails ?? "{}") as RideSnapshot;
        await takeSeat(cart.id, req.userId!, ride.seats);
      } else {
        await addMember(cart.id, req.userId!); // joining establishes membership
      }
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

// ---------- name the group ----------
//
// The design puts a name and an emoji at the top of every group screen. Host
// only: a name is how members recognise the room, and letting anyone rewrite it
// mid-order is a small but real way to confuse people into the wrong cart.
groupsRouter.patch(
  "/:id",
  validateBody(
    z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        emoji: z
          .string()
          .trim()
          .max(8)
          .refine((v) => v.length === 0 || [...v].length <= 2, "One emoji, please")
          .optional(),
      })
      .strict()
      .refine((v) => v.name !== undefined || v.emoji !== undefined, "Nothing to change"),
  ),
  async (req, res, next) => {
    try {
      const cart = await assertMember(req.params.id!, req.userId!);
      if (cart.hostId !== req.userId!) {
        throw new ApiError(403, "Only the host can rename the group");
      }
      const { name, emoji } = req.body as { name?: string; emoji?: string };
      await prisma.groupCart.update({
        where: { id: cart.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(emoji !== undefined ? { emoji: emoji || null } : {}),
        },
      });
      res.json(await summarize(cart.id, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

// ---------- nudge the people who have not ordered ----------
//
// WHO it reaches is limited by its own nature: only members with nothing in the
// cart, so once someone orders they stop being remindable.
//
// How OFTEN each of them hears about it was not limited at all, and the comment
// that used to sit here claimed it was. Those are different questions. A host
// who keeps tapping sent an unbounded stream of notifications to the lock
// screen of everyone still reading the menu, and a member cannot order their
// way out of a cart they did not want to be in.
//
// So a reminder is per PERSON, not per tap: somebody already nudged in the last
// few minutes is skipped, and the count that comes back is who was actually
// told rather than who was eligible. Kept in memory on purpose — this is a
// nudge, and the worst a restart can cost is one extra notification, which is
// not worth a column and a write on the hot path.
const REMIND_COOLDOWN_MS = 5 * 60_000;
const remindedAt = new Map<string, number>();

/** Who among `userIds` has not been nudged about this cart recently. */
function dueForReminder(cartId: string, userIds: string[]): string[] {
  const now = Date.now();
  // Housekeeping first, so the map cannot grow without bound.
  for (const [key, at] of remindedAt) {
    if (now - at > REMIND_COOLDOWN_MS) remindedAt.delete(key);
  }
  const due: string[] = [];
  for (const userId of userIds) {
    const key = `${cartId}:${userId}`;
    if (remindedAt.has(key)) continue;
    remindedAt.set(key, now);
    due.push(userId);
  }
  return due;
}

groupsRouter.post("/:id/remind", async (req, res, next) => {
  try {
    const cart = await assertMember(req.params.id!, req.userId!);
    if (cart.hostId !== req.userId!) {
      throw new ApiError(403, "Only the host can send a reminder");
    }
    if (cart.status !== "open") throw new ApiError(409, "This group order is closed");

    const members = await prisma.groupCartMember.findMany({
      where: { cartId: cart.id, NOT: { userId: req.userId! } },
      select: { userId: true },
    });
    const ordered = await prisma.groupCartItem.findMany({
      where: { cartId: cart.id },
      select: { userId: true },
      distinct: ["userId"],
    });
    const done = new Set(ordered.map((o) => o.userId));
    const waiting = members.filter((m) => !done.has(m.userId));
    const due = dueForReminder(cart.id, waiting.map((m) => m.userId));

    const label = `${cart.emoji ?? ""} ${cart.name ?? "Group order"}`.trim();
    for (const userId of due) {
      void sendPushToUser(userId, {
        title: label,
        body: "Everyone is waiting on your order.",
        url: `/food/group/${cart.id}`,
      });
    }
    // What was actually sent. Reporting the eligible count instead would tell
    // the host four people were nudged when none of them were.
    res.json({ reminded: due.length, waiting: waiting.length });
  } catch (err) {
    next(err);
  }
});

// ---------- the group deal ----------
groupsRouter.get("/:id/suggestion", async (req, res, next) => {
  try {
    const cart = await assertMember(req.params.id!, req.userId!);
    if (cart.domain !== "food") return res.json({ suggestion: null });
    const [items, memberCount] = await Promise.all([
      prisma.groupCartItem.findMany({
        where: { cartId: cart.id },
        select: { id: true, userId: true, dishId: true, pricePaise: true, qty: true },
      }),
      prisma.groupCartMember.count({ where: { cartId: cart.id } }),
    ]);
    res.json({
      suggestion: suggestForCart({
        items,
        platform: cart.platform,
        memberCount: Math.max(1, memberCount),
      }),
    });
  } catch (err) {
    next(err);
  }
});

// Swaps the matched items for the pack. Host only, because it removes other
// people's choices from the cart — and it re-derives the suggestion here rather
// than trusting the client's copy, so a stale screen cannot delete items the
// current cart no longer justifies removing.
groupsRouter.post("/:id/suggestion/apply", async (req, res, next) => {
  try {
    const cart = await assertMember(req.params.id!, req.userId!);
    if (cart.hostId !== req.userId!) {
      throw new ApiError(403, "Only the host can apply a group deal");
    }
    if (cart.status !== "open") throw new ApiError(409, "This group order is closed");

    const [items, memberCount] = await Promise.all([
      prisma.groupCartItem.findMany({
        where: { cartId: cart.id },
        select: { id: true, userId: true, dishId: true, pricePaise: true, qty: true },
      }),
      prisma.groupCartMember.count({ where: { cartId: cart.id } }),
    ]);
    const suggestion = suggestForCart({
      items,
      platform: cart.platform,
      memberCount: Math.max(1, memberCount),
    });
    if (!suggestion) throw new ApiError(409, "That deal no longer applies to this cart");

    const quote = quotesForDish(suggestion.dishId).find((q) => q.platform === cart.platform);
    if (!quote) throw new ApiError(404, "That pack is no longer available");

    await prisma.$transaction([
      prisma.groupCartItem.deleteMany({
        where: { cartId: cart.id, id: { in: suggestion.replacesItemIds } },
      }),
      prisma.groupCartItem.create({
        data: {
          cartId: cart.id,
          userId: req.userId!,
          dishId: suggestion.dishId,
          name: quote.name,
          pricePaise: quote.effectivePaise,
          qty: 1,
        },
      }),
    ]);

    res.json({
      applied: suggestion.savingPaise,
      cart: await summarize(cart.id, req.userId!),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- add item ----------
groupsRouter.post(
  "/:id/items",
  validateBody(
    z.object({ dishId: z.string().max(60), qty: z.number().int().min(1).max(20).default(1) }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { dishId, qty } = req.body as { dishId: string; qty: number };
      res.status(201).json(await addGroupItem({ cartId: req.params.id!, userId: req.userId!, dishId, qty }));
    } catch (err) {
      next(err);
    }
  },
);

// ---------- remove own item ----------
groupsRouter.delete("/:id/items/:itemId", async (req, res, next) => {
  try {
    const cart = await assertMember(req.params.id!, req.userId!);
    // Once the host has checked out, the cart is the record of who owes what:
    // it is the screen the host chases shares from, and the UPI links were
    // built off it. Removing an item was allowed at any time, so a member could
    // order, let the host pay for the lot, then delete their own lines and the
    // settle-up screen would show them owing nothing. The food is bought by
    // then, so there is nothing to take out of the order either.
    if (cart.status !== "open") {
      throw new ApiError(409, "This group order has been placed, items can't be removed");
    }
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
          env.GOOGLE_MAPS_API_KEY,
        );
        const quotes = quoteRides({
          distanceKm: route.distanceKm,
          rideMinutes: route.rideMinutes,
        });
        const quote = quotes.find(
          (q) => q.provider === ride.provider && q.productName === ride.productName,
        );
        if (!quote) throw new ApiError(404, "That ride option is no longer available");

        // The group agreed to the fare it was shown. If the trip now prices
        // differently (later traffic, a different road), nobody is charged a
        // total they never saw: the new fare replaces the old one, every
        // member's screen shows it and their share of it, and the host books
        // again knowing what everyone will pay.
        if (quote.effectivePaise !== ride.farePaise) {
          await prisma.groupCart.update({
            where: { id: cart.id },
            data: { rideDetails: JSON.stringify({ ...ride, farePaise: quote.effectivePaise }) },
          });
          throw new ApiError(
            409,
            `The fare has changed to ${rupeesExact(quote.effectivePaise)} since the group was set up. ` +
              "Everyone's share has been updated, so check it and book again.",
          );
        }

        const hostName =
          cart.members.find((m) => m.userId === cart.hostId)?.user.name ?? "Host";
        const memberCount = Math.max(1, cart.members.length);
        const split = splitFare(quote.effectivePaise, memberCount);
        const sharePaise = split.otherPaise;
        // Each rider's Privacy setting still applies at checkout. These names
        // were read straight off the User row, so the settle-up screen — and
        // the UPI note, and the copy written into the order record for good —
        // printed the real name of a rider the cart screen had already agreed
        // to call "Flouna user".
        const rideView = await privacyView(
          req.userId!,
          cart.members.map((m) => m.userId),
          cart.id,
        );
        const shares = cart.members.map((m) => {
          const name = rideView.nameFor(m.userId, m.user.name);
          return {
            userId: m.userId,
            name,
            sharePaise: m.userId === cart.hostId ? split.hostPaise : sharePaise,
            isHost: m.userId === cart.hostId,
            upiLink:
              m.userId === cart.hostId || !hostUpiId
                ? null
                : upiLink({
                    payeeUpi: hostUpiId,
                    payeeName: hostName,
                    amountPaise: sharePaise,
                    note: `Shared ride (${name})`,
                  }),
          };
        });

        // The group is claimed and its order created together, or neither.
        // Checkout used to read the group as open, create the order, then mark
        // it ordered; two taps at once both read it as open and both created
        // an order. The claim is a conditional write, so only one wins.
        const order = await prisma.$transaction(async (tx) => {
          const claimed = await tx.groupCart.updateMany({
            where: { id: cart.id, status: "open" },
            data: { status: "ordered" },
          });
          if (claimed.count === 0) throw new ApiError(409, "Already checked out");
          const created = await tx.order.create({
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
          await tx.groupCart.update({
            where: { id: cart.id },
            data: { orderId: created.id },
          });
          return created;
        });


        // Everyone in the ride learns it's booked (host is on the pay screen).
        for (const m of cart.members) {
          if (m.userId === cart.hostId) continue;
          void sendPushToUser(m.userId, {
            title: "Your shared ride is booked 🚕",
            body: `${quote.displayName} to ${ride.drop}, your share is ${rupeesExact(sharePaise)}.`,
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

      // Same Privacy pass as the ride split above, and for the same reason.
      const foodView = await privacyView(req.userId!, [...owed.keys()], cart.id);

      const shares = [...owed.entries()].map(([userId, m]) => {
        const name = foodView.nameFor(userId, m.name);
        return {
          userId,
          name,
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
                  note: `Group order share (${name})`,
                }),
        };
      });

      // The host's address is where the whole group order gets delivered, so
      // it's required here just like a solo food order.
      const deliveryAddress =
        (await prisma.address.findFirst({
          where: { userId: req.userId!, isDefault: true },
        })) ??
        (await prisma.address.findFirst({
          where: { userId: req.userId! },
          orderBy: { createdAt: "desc" },
        }));
      if (!deliveryAddress) {
        throw new ApiError(
          400,
          "Add a delivery address before checking out the group order",
        );
      }

      // The group is claimed and its order created together, or neither.
      // Checkout used to read the group as open, create the order, then mark
      // it ordered; two taps at once both read it as open and both created
      // an order. The claim is a conditional write, so only one wins.
      const order = await prisma.$transaction(async (tx) => {
        const claimed = await tx.groupCart.updateMany({
          where: { id: cart.id, status: "open" },
          data: { status: "ordered" },
        });
        if (claimed.count === 0) throw new ApiError(409, "Already checked out");
        const created = await tx.order.create({
          data: {
            userId: req.userId!,
            addressId: deliveryAddress.id,
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
        await tx.groupCart.update({
          where: { id: cart.id },
          data: { orderId: created.id },
        });
        return created;
      });


      res.json({ orderId: order.id, totalPaise, shares });
    } catch (err) {
      next(err);
    }
  },
);
