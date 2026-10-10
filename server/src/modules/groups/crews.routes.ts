import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { quotesForDish } from "../food/food.service.js";
import { sendPushToUser } from "../notifications/push.service.js";

// Saved crews.
//
// A group order today costs a link, a wait, and four people remembering to tap
// it. That is a fair price the first time and an absurd one the fifth. A crew
// is the people, kept: reopen it and everyone is already a member, with an
// option to re-add exactly what each of them ordered last time.
//
// Two rules keep this from becoming a way to pull people into rooms they never
// agreed to. A crew can only contain people who have actually shared a cart
// with the owner, so membership is always earned by a real join. And blocking
// removes someone from the reopened cart, in both directions, the same way it
// closes a join.

export const crewsRouter = Router();
crewsRouter.use(requireAuth);

/** Short, unambiguous join code (no 0/O/1/I), from the CSPRNG. */
function generateJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[bytes[i]! % alphabet.length];
  return code;
}

const nameSchema = z.string().trim().min(1).max(40);
// One emoji, not a decorative string: the design puts it beside the name.
const emojiSchema = z
  .string()
  .trim()
  .max(8)
  .refine((v) => v.length === 0 || [...v].length <= 2, "One emoji, please");

async function crewView(crewId: string, ownerId: string) {
  const crew = await prisma.groupCrew.findFirst({
    where: { id: crewId, ownerId },
    include: {
      members: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!crew) throw new ApiError(404, "Crew not found");

  // What they ordered last time, so the reopen screen can offer it.
  let usual: { dishId: string; name: string; qty: number; memberName: string }[] = [];
  if (crew.lastCartId) {
    const items = await prisma.groupCartItem.findMany({
      where: { cartId: crew.lastCartId },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    });
    usual = items.map((i) => ({
      dishId: i.dishId,
      name: i.name,
      qty: i.qty,
      memberName: i.user.name,
    }));
  }

  return {
    id: crew.id,
    name: crew.name,
    emoji: crew.emoji,
    domain: crew.domain,
    platform: crew.platform,
    lastCartId: crew.lastCartId,
    updatedAt: crew.updatedAt,
    members: crew.members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      isYou: m.userId === ownerId,
    })),
    usual,
  };
}

// ---------- list ----------
crewsRouter.get("/", async (req, res, next) => {
  try {
    const crews = await prisma.groupCrew.findMany({
      where: { ownerId: req.userId! },
      orderBy: { updatedAt: "desc" },
      take: 20,
      include: {
        members: {
          include: { user: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    res.json({
      crews: crews.map((c) => ({
        id: c.id,
        name: c.name,
        emoji: c.emoji,
        domain: c.domain,
        platform: c.platform,
        lastCartId: c.lastCartId,
        updatedAt: c.updatedAt,
        members: c.members.map((m) => ({
          userId: m.userId,
          name: m.user.name,
          isYou: m.userId === req.userId,
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

crewsRouter.get("/:id", async (req, res, next) => {
  try {
    res.json({ crew: await crewView(req.params.id!, req.userId!) });
  } catch (err) {
    next(err);
  }
});

// ---------- save a cart as a crew ----------
//
// Saving from a cart rather than picking names out of the air is the whole
// safety model: the members are people who joined that cart themselves.
crewsRouter.post(
  "/",
  validateBody(
    z
      .object({
        cartId: z.string().cuid(),
        name: nameSchema,
        emoji: emojiSchema.optional(),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const { cartId, name, emoji } = req.body as {
        cartId: string;
        name: string;
        emoji?: string;
      };
      const cart = await prisma.groupCart.findUnique({
        where: { id: cartId },
        include: { members: { select: { userId: true } } },
      });
      if (!cart) throw new ApiError(404, "Group order not found");
      // Only someone who was in the room can keep the room.
      const inCart =
        cart.hostId === req.userId! ||
        cart.members.some((m) => m.userId === req.userId!);
      if (!inCart) throw new ApiError(403, "Join this group order first");

      const memberIds = [
        ...new Set([req.userId!, cart.hostId, ...cart.members.map((m) => m.userId)]),
      ];

      let crew;
      try {
        crew = await prisma.groupCrew.create({
          data: {
            ownerId: req.userId!,
            name,
            emoji: emoji || null,
            domain: cart.domain,
            platform: cart.platform,
            lastCartId: cart.id,
            members: { create: memberIds.map((userId) => ({ userId })) },
          },
        });
      } catch {
        throw new ApiError(409, "You already have a crew with that name");
      }
      res.status(201).json({ crew: await crewView(crew.id, req.userId!) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- rename ----------
crewsRouter.patch(
  "/:id",
  validateBody(
    z
      .object({ name: nameSchema.optional(), emoji: emojiSchema.optional() })
      .strict()
      .refine((v) => v.name !== undefined || v.emoji !== undefined, "Nothing to change"),
  ),
  async (req, res, next) => {
    try {
      const { name, emoji } = req.body as { name?: string; emoji?: string };
      const owned = await prisma.groupCrew.findFirst({
        where: { id: req.params.id, ownerId: req.userId! },
        select: { id: true },
      });
      if (!owned) throw new ApiError(404, "Crew not found");
      try {
        await prisma.groupCrew.update({
          where: { id: owned.id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(emoji !== undefined ? { emoji: emoji || null } : {}),
          },
        });
      } catch {
        throw new ApiError(409, "You already have a crew with that name");
      }
      res.json({ crew: await crewView(owned.id, req.userId!) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- remove a member / delete ----------
crewsRouter.delete("/:id/members/:userId", async (req, res, next) => {
  try {
    const crew = await prisma.groupCrew.findFirst({
      where: { id: req.params.id, ownerId: req.userId! },
      select: { id: true },
    });
    if (!crew) throw new ApiError(404, "Crew not found");
    if (req.params.userId === req.userId!) {
      throw new ApiError(400, "You cannot remove yourself from your own crew");
    }
    const gone = await prisma.groupCrewMember.deleteMany({
      where: { crewId: crew.id, userId: req.params.userId },
    });
    if (gone.count === 0) throw new ApiError(404, "Not in this crew");
    res.json({ crew: await crewView(crew.id, req.userId!) });
  } catch (err) {
    next(err);
  }
});

crewsRouter.delete("/:id", async (req, res, next) => {
  try {
    const gone = await prisma.groupCrew.deleteMany({
      where: { id: req.params.id, ownerId: req.userId! },
    });
    if (gone.count === 0) throw new ApiError(404, "Crew not found");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- reopen ----------
//
// Creates a fresh cart with the crew already seated. Optionally re-adds what
// each member ordered last time, priced from the catalogue now — a saved crew
// must never be able to resurrect last month's price.
crewsRouter.post(
  "/:id/reopen",
  validateBody(
    z.object({ withUsual: z.boolean().default(false) }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { withUsual } = req.body as { withUsual: boolean };
      const crew = await prisma.groupCrew.findFirst({
        where: { id: req.params.id, ownerId: req.userId! },
        include: { members: { select: { userId: true } } },
      });
      if (!crew) throw new ApiError(404, "Crew not found");
      if (crew.domain !== "food") {
        // A shared ride is a specific trip at a specific time; there is nothing
        // honest to reopen. The crew is still useful as a list of people.
        throw new ApiError(400, "Only food crews can be reopened");
      }

      // Blocking, in both directions, since the last time they ordered.
      const blocks = await prisma.blockedUser.findMany({
        where: {
          OR: [
            { userId: req.userId!, blockedUserId: { in: crew.members.map((m) => m.userId) } },
            { blockedUserId: req.userId!, userId: { in: crew.members.map((m) => m.userId) } },
          ],
        },
        select: { userId: true, blockedUserId: true },
      });
      const excluded = new Set<string>();
      for (const b of blocks) {
        excluded.add(b.userId === req.userId! ? b.blockedUserId : b.userId);
      }

      const invited = crew.members
        .map((m) => m.userId)
        .filter((id) => id === req.userId! || !excluded.has(id));

      // A join code is the only thing standing between a stranger and a cart's
      // member names and items, so it comes from the CSPRNG — the same way the
      // create route mints one. Math.random is a seeded xorshift whose state is
      // recoverable from a handful of outputs, and a host can see as many codes
      // as they like by reopening, so the next crew's code was predictable.
      // Retried on the rare collision, because `code` is unique and the create
      // route's loop was missing here: a clash answered the host with a 500.
      let cart;
      for (let attempt = 0; attempt < 5 && !cart; attempt++) {
        cart = await prisma.groupCart
          .create({
            data: {
              code: generateJoinCode(),
              hostId: req.userId!,
              domain: "food",
              platform: crew.platform,
              name: crew.name,
              emoji: crew.emoji,
              crewId: crew.id,
              members: { create: invited.map((userId) => ({ userId })) },
            },
          })
          .catch((err: { code?: string }) => {
            if (err?.code !== "P2002") throw err;
            return undefined;
          });
      }
      if (!cart) throw new ApiError(503, "Could not reopen the group order, try again");

      // Re-add last time's items, repriced. Anything delisted is dropped rather
      // than guessed at, and the response says how many so the screen can be
      // honest about it instead of silently shrinking the order.
      let readded = 0;
      let unavailable = 0;
      if (withUsual && crew.lastCartId) {
        const previous = await prisma.groupCartItem.findMany({
          where: { cartId: crew.lastCartId, userId: { in: invited } },
          orderBy: { createdAt: "asc" },
        });
        for (const item of previous) {
          const quote = quotesForDish(item.dishId).find((q) => q.platform === crew.platform);
          if (!quote) {
            unavailable++;
            continue;
          }
          await prisma.groupCartItem.create({
            data: {
              cartId: cart.id,
              userId: item.userId,
              dishId: item.dishId,
              name: quote.name,
              pricePaise: quote.effectivePaise, // today's price, always
              qty: item.qty,
            },
          });
          readded++;
        }
      }

      await prisma.groupCrew.update({
        where: { id: crew.id },
        data: { lastCartId: cart.id },
      });

      // Everyone who was seated without asking deserves to be told.
      for (const userId of invited) {
        if (userId === req.userId!) continue;
        void sendPushToUser(userId, {
          title: `${crew.emoji ?? ""} ${crew.name}`.trim(),
          body: "The group order is open again.",
          url: `/food/group/${cart.id}`,
        });
      }

      res.status(201).json({
        cartId: cart.id,
        code: cart.code,
        invited: invited.length,
        excluded: crew.members.length - invited.length,
        readded,
        unavailable,
      });
    } catch (err) {
      next(err);
    }
  },
);
