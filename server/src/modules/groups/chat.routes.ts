import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { CONTENDED_TX, withTxRetry } from "../../lib/txRetry.js";
import { registerChatDevice } from "./chatDevices.service.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { sendPushToUser } from "../notifications/push.service.js";
import { privacyView } from "./privacy.js";

// End-to-end encrypted group chat, on the Sender Keys design that Signal and
// WhatsApp use for groups.
//
// Every sending DEVICE owns a chain: a random chain key that ratchets forward
// one way per message. The key for message N is derived from the chain key at
// N, and the chain key at N+1 is derived from that same value, so a key
// captured today cannot open yesterday's messages. Each device hands its chain
// to every other member device once, sealed to that device's public key, and
// after that it simply sends.
//
// The server's whole job is to be a courier that cannot read the post:
//
//   · public keys, which are public by definition
//   · sealed distribution messages it has no key for
//   · ciphertext with a nonce, a chain index and a signature
//
// It knows who spoke, from which device, and when, because it has to route and
// order messages. It knows nothing about what was said.
//
// The honest limit, stated here and in the UI rather than papered over: the
// server serves the JavaScript that does the crypto, and the server decides
// which devices appear in a member's device list. A compromised server could
// therefore add a device and have members seal to it. That is true of every
// in-browser E2EE product, and the answer used here is the one everyone else
// uses — surface the device list and a safety number, so a change is visible.

export const groupChatRouter = Router({ mergeParams: true });
groupChatRouter.use(requireAuth);

/**
 * The cart id arrives from the parent router through mergeParams, which Express
 * cannot type for a child router — so it is read through one narrow cast here
 * rather than a cast at every use.
 */
function cartIdOf(req: { params: unknown }): string {
  const id = (req.params as { id?: string }).id;
  if (!id) throw new ApiError(404, "Group order not found");
  return id;
}

/** Base64 of a bounded size — enough to reject junk without parsing crypto. */
const b64 = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/=]+$/, "Expected base64");

const deviceIdSchema = z.string().trim().min(8).max(64);

/** Membership is the whole access-control story: chat is per-cart. */
async function assertMember(cartId: string, userId: string) {
  const cart = await prisma.groupCart.findUnique({
    where: { id: cartId },
    select: { id: true, hostId: true, name: true },
  });
  if (!cart) throw new ApiError(404, "Group order not found");
  if (cart.hostId === userId) return cart;
  const member = await prisma.groupCartMember.findUnique({
    where: { cartId_userId: { cartId, userId } },
  });
  if (!member) throw new ApiError(403, "Join this group order first");
  return cart;
}

/** Everyone entitled to be in this conversation. */
async function memberIdsOf(cartId: string): Promise<string[]> {
  const cart = await prisma.groupCart.findUniqueOrThrow({
    where: { id: cartId },
    select: { hostId: true, members: { select: { userId: true } } },
  });
  return [...new Set([cart.hostId, ...cart.members.map((m) => m.userId)])];
}

/**
 * Confirms the caller is speaking as a device they actually registered.
 *
 * Without this a member could publish under someone else's device id, and since
 * recipients key their chain state by device id, quietly take over that
 * device's chain as far as every recipient is concerned.
 */
async function assertOwnDevice(userId: string, deviceId: string) {
  const device = await prisma.chatDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
    select: { id: true },
  });
  if (!device) throw new ApiError(403, "Register this device first");
}

// ---------- device identity ----------

/**
 * Registers this browser's public keys: one for sealing things TO it, one for
 * proving things came FROM it.
 *
 * Re-registering the same deviceId replaces both, which is what happens when a
 * user clears site data: the private halves are gone for good, so the old
 * public halves are worthless and keeping them would only make members seal
 * chains nobody can open. When the key does change, every chain sealed to the
 * old one is dropped so senders re-seal — otherwise the device would sit
 * holding envelopes it can never open and blame the network.
 */
groupChatRouter.post(
  "/devices",
  validateBody(
    z
      .object({
        deviceId: deviceIdSchema,
        publicKey: b64(500),
        signingKey: b64(500),
        label: z.string().trim().max(60).optional(),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const cartId = cartIdOf(req);
      await assertMember(cartId, req.userId!);
      const { deviceId, publicKey, signingKey, label } = req.body as {
        deviceId: string;
        publicKey: string;
        signingKey: string;
        label?: string;
      };

      const { device, rekeyed } = await registerChatDevice(req.userId!, {
        deviceId,
        publicKey,
        signingKey,
        label,
      });

      res.status(201).json({ device, rekeyed });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- sender keys ----------

/**
 * Everything a device needs to take part: every member device's public keys,
 * the chains sealed for THIS device, the devices this caller still owes its own
 * chain to, and any history waiting to be handed over.
 *
 * Chains are scoped to the calling device. You are never handed one sealed for
 * somebody else — including another of your own devices — because that is
 * precisely the string an attacker would want to collect and grind on offline.
 */
groupChatRouter.get("/keys", async (req, res, next) => {
  try {
    const cartId = cartIdOf(req);
    await assertMember(cartId, req.userId!);
    const memberIds = await memberIdsOf(cartId);

    const devices = await prisma.chatDevice.findMany({
      where: { userId: { in: memberIds } },
      select: {
        userId: true,
        deviceId: true,
        publicKey: true,
        signingKey: true,
        createdAt: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    // Which of the caller's devices is asking. Only that device's inbound
    // chains come back.
    const asDevice =
      typeof req.query.deviceId === "string" ? req.query.deviceId : undefined;
    if (asDevice) await assertOwnDevice(req.userId!, asDevice);

    const inbound = asDevice
      ? await prisma.senderKeyEnvelope.findMany({
          where: { cartId, recipientId: req.userId!, recipientDevice: asDevice },
          select: {
            senderId: true,
            senderDevice: true,
            senderKey: true,
            iv: true,
            payload: true,
          },
        })
      : [];

    // Devices this caller has not yet handed its own chain to.
    const alreadySent = asDevice
      ? await prisma.senderKeyEnvelope.findMany({
          where: { cartId, senderDevice: asDevice },
          select: { recipientDevice: true },
        })
      : [];
    const sentTo = new Set(alreadySent.map((e) => e.recipientDevice));
    const owed = asDevice ? devices.filter((d) => !sentTo.has(d.deviceId)) : [];

    // History waiting for this device, from another device of the same user.
    const history = asDevice
      ? await prisma.historySync.findUnique({
          where: { cartId_toDevice: { cartId, toDevice: asDevice } },
          select: { fromDevice: true, senderKey: true, iv: true, payload: true },
        })
      : null;

    // A device list is a list of people, so it goes through the same Privacy
    // settings the cart screen applies. Read straight off the User row, it
    // handed back the real name of a member whose profile is set to "nobody" —
    // the cart called them "Flouna user" and this call, one tap away in the
    // same cart, named them.
    const view = await privacyView(req.userId!, memberIds, cartId);

    res.json({
      devices: devices.map((d) => ({
        userId: d.userId,
        name: view.nameFor(d.userId, d.user.name),
        deviceId: d.deviceId,
        publicKey: d.publicKey,
        signingKey: d.signingKey,
        addedAt: d.createdAt,
        isYou: d.userId === req.userId,
      })),
      inbound,
      owed: owed.map((d) => ({
        userId: d.userId,
        deviceId: d.deviceId,
        publicKey: d.publicKey,
      })),
      history,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Publishes this device's chain, sealed once per recipient device.
 *
 * The server cannot tell a good envelope from a bad one, so it makes the checks
 * it actually can: the sender must own the device it claims to be, the
 * recipient must be in this cart, and an envelope that already exists is never
 * replaced. That last rule is what stops a member re-sealing a chain around a
 * value of their own choosing after the fact.
 */
groupChatRouter.post(
  "/keys",
  validateBody(
    z
      .object({
        senderDevice: deviceIdSchema,
        envelopes: z
          .array(
            z
              .object({
                recipientId: z.string().cuid(),
                recipientDevice: deviceIdSchema,
                senderKey: b64(500),
                iv: b64(64),
                payload: b64(2000),
              })
              .strict(),
          )
          .min(1)
          .max(60),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const cartId = cartIdOf(req);
      await assertMember(cartId, req.userId!);
      const { senderDevice, envelopes } = req.body as {
        senderDevice: string;
        envelopes: {
          recipientId: string;
          recipientDevice: string;
          senderKey: string;
          iv: string;
          payload: string;
        }[];
      };
      await assertOwnDevice(req.userId!, senderDevice);

      const memberIds = new Set(await memberIdsOf(cartId));

      let written = 0;
      for (const e of envelopes) {
        if (!memberIds.has(e.recipientId)) continue; // not in this room
        try {
          await prisma.senderKeyEnvelope.create({
            data: {
              cartId,
              senderId: req.userId!,
              senderDevice,
              recipientId: e.recipientId,
              recipientDevice: e.recipientDevice,
              senderKey: e.senderKey,
              iv: e.iv,
              payload: e.payload,
            },
          });
          written++;
        } catch {
          // Already sealed for that device. First writer wins, on purpose.
        }
      }
      res.status(201).json({ written });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- history sync ----------

/**
 * Hands a conversation's past from one of a user's devices to another of their
 * own devices.
 *
 * Restricted to the same user at both ends. Letting anyone hand you a "history"
 * would let a member rewrite what you believe was said before you arrived,
 * which is worse than having no history at all.
 */
groupChatRouter.post(
  "/history",
  validateBody(
    z
      .object({
        fromDevice: deviceIdSchema,
        toDevice: deviceIdSchema,
        senderKey: b64(500),
        iv: b64(64),
        payload: b64(400_000),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const cartId = cartIdOf(req);
      await assertMember(cartId, req.userId!);
      const body = req.body as {
        fromDevice: string;
        toDevice: string;
        senderKey: string;
        iv: string;
        payload: string;
      };
      if (body.fromDevice === body.toDevice) {
        throw new ApiError(400, "A device cannot sync history to itself");
      }
      await assertOwnDevice(req.userId!, body.fromDevice);
      await assertOwnDevice(req.userId!, body.toDevice);

      try {
        await prisma.historySync.create({
          data: { cartId, userId: req.userId!, ...body },
        });
      } catch {
        // Already delivered. First writer wins here too, so a later device
        // cannot replace a history the recipient may already have read.
        return res.json({ written: false });
      }
      res.status(201).json({ written: true });
    } catch (err) {
      next(err);
    }
  },
);

/** Marks a delivered history as consumed, so it is not stored any longer than
 *  the handover needs it to be. */
groupChatRouter.delete("/history/:deviceId", async (req, res, next) => {
  try {
    const cartId = cartIdOf(req);
    await assertMember(cartId, req.userId!);
    const deviceId = req.params.deviceId!;
    await assertOwnDevice(req.userId!, deviceId);
    await prisma.historySync.deleteMany({ where: { cartId, toDevice: deviceId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- messages ----------

const MAX_CIPHERTEXT = 8000; // ~4KB of plaintext once base64 and GCM overhead

groupChatRouter.get("/messages", async (req, res, next) => {
  try {
    const cartId = cartIdOf(req);
    await assertMember(cartId, req.userId!);
    // `after` lets a client poll for only what is new instead of refetching a
    // conversation it already holds in plaintext locally.
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const cursor = after ? new Date(after) : undefined;
    const messages = await prisma.groupMessage.findMany({
      where: {
        cartId,
        ...(cursor && !Number.isNaN(cursor.getTime()) ? { createdAt: { gt: cursor } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: {
        id: true,
        senderId: true,
        senderDevice: true,
        index: true,
        version: true,
        iv: true,
        ciphertext: true,
        signature: true,
        createdAt: true,
        sender: { select: { name: true } },
      },
    });
    // Same reason as the device list: every message carries its sender's name,
    // and that name is the member's to withhold.
    const view = await privacyView(req.userId!, await memberIdsOf(cartId), cartId);
    res.json({
      messages: messages.map((m) => ({
        id: m.id,
        senderId: m.senderId,
        senderName: view.nameFor(m.senderId, m.sender.name),
        senderDevice: m.senderDevice,
        index: m.index,
        version: m.version,
        isYou: m.senderId === req.userId,
        iv: m.iv,
        ciphertext: m.ciphertext,
        signature: m.signature,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

groupChatRouter.post(
  "/messages",
  validateBody(
    z
      .object({
        senderDevice: deviceIdSchema,
        index: z.number().int().min(0).max(1_000_000),
        iv: b64(64),
        ciphertext: b64(MAX_CIPHERTEXT),
        signature: b64(300),
      })
      .strict(),
  ),
  async (req, res, next) => {
    try {
      const cartId = cartIdOf(req);
      const cart = await assertMember(cartId, req.userId!);
      const { senderDevice, index, iv, ciphertext, signature } = req.body as {
        senderDevice: string;
        index: number;
        iv: string;
        ciphertext: string;
        signature: string;
      };
      await assertOwnDevice(req.userId!, senderDevice);

      // A chain position is used exactly once. Reusing one is either a replay
      // or a client bug, and both end with a recipient deriving a key for a
      // message that is not the one it is trying to open.
      //
      // Claimed and written in one step. The check used to be a read followed
      // by an insert, with nothing holding the position in between: two
      // messages sent at the same moment — which is exactly what two tabs, or
      // a retry racing the original, produce — both read the position as free
      // and both stored a row at it. There is no unique index to catch that
      // (the column has a plain index), so both survived, and the recipient
      // ratchets once: one of the two can never be opened by anybody, in a
      // conversation whose whole promise is that it arrives. Serializable, so
      // the database refuses one of a conflicting pair, and the refused one
      // retries and finds the position taken.
      const message = await withTxRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const clash = await tx.groupMessage.findFirst({
              where: { cartId, senderDevice, index },
              select: { id: true },
            });
            if (clash) throw new ApiError(409, "That chain position is already used");
            return tx.groupMessage.create({
              data: {
                cartId,
                senderId: req.userId!,
                senderDevice,
                index,
                version: 2,
                iv,
                ciphertext,
                signature,
              },
              select: {
                id: true,
                senderId: true,
                senderDevice: true,
                index: true,
                version: true,
                iv: true,
                ciphertext: true,
                signature: true,
                createdAt: true,
              },
            });
          },
          CONTENDED_TX,
        ),
      );

      // The push cannot carry the message, because the server does not have it.
      // It says who spoke and where; the text appears once the app decrypts it.
      const me = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { name: true },
      });
      const others = await prisma.groupCartMember.findMany({
        where: { cartId, NOT: { userId: req.userId! } },
        select: { userId: true },
      });
      // The name in the notification is the sender's to withhold too, and a
      // lock-screen is the one place it is read by someone who never opened the
      // app. Resolved per recipient, because "contacts" means a different set
      // of people for each of them.
      for (const o of others) {
        void privacyView(o.userId, [req.userId!], cartId)
          .then((view) =>
            sendPushToUser(o.userId, {
              title: cart.name ?? "Group order",
              body: `${view.nameFor(req.userId!, me?.name ?? "Someone")} sent a message`,
              url: `/food/group/${cartId}/chat`,
            }),
          )
          .catch(() => {
            // A notification must never break the message it announces.
          });
      }

      res.status(201).json({ message: { ...message, isYou: true } });
    } catch (err) {
      next(err);
    }
  },
);
