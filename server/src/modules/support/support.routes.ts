import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { ApiError } from "../../middleware/error.js";
import { makeLimiter } from "../../middleware/rateLimit.js";
import { createTicket } from "../backoffice/tickets.service.js";
import { greet, respond, type BotOption } from "./support.bot.js";
import { SUPPORT_TOPICS, searchTopics, topicBySlug } from "./support.kb.js";

export const supportRouter = Router();

// A chat turn is cheap but not free — it reads several tables per message.
const chatLimiter = makeLimiter({
  windowMs: 60_000,
  limit: 40,
  message: "You're sending messages very quickly, give it a moment.",
});

// Topics and articles are public knowledge: readable without a session so the
// Help Centre can be linked to from an email or a signed-out state later.
supportRouter.get("/topics", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json({
    topics: searchTopics(q).map((t) => ({
      slug: t.slug,
      group: t.group,
      title: t.title,
      summary: t.summary,
    })),
  });
});

supportRouter.get("/topics/:slug", (req, res, next) => {
  try {
    const topic = topicBySlug(req.params.slug!);
    if (!topic) throw new ApiError(404, "No such help topic");
    res.json({
      topic: {
        slug: topic.slug,
        group: topic.group,
        title: topic.title,
        summary: topic.summary,
        article: topic.article,
      },
    });
  } catch (err) {
    next(err);
  }
});

// The Help Centre's Top Topics list, grouped as the screen renders them.
supportRouter.get("/groups", (_req, res) => {
  const groups = ["orders", "rides", "payments", "offers", "account"] as const;
  res.json({
    groups: groups.map((g) => ({
      group: g,
      topics: SUPPORT_TOPICS.filter((t) => t.group === g).map((t) => ({
        slug: t.slug,
        title: t.title,
        summary: t.summary,
      })),
    })),
  });
});

// Everything below is the customer's own conversation.
supportRouter.use(requireAuth);

/** Shape sent to the client for one chat. */
async function serialise(chatId: string) {
  const chat = await prisma.supportChat.findUniqueOrThrow({
    where: { id: chatId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  return {
    id: chat.id,
    status: chat.status,
    topic: chat.topic,
    orderId: chat.orderId,
    ticketId: chat.ticketId,
    ratingStars: chat.ratingStars,
    startedAt: chat.startedAt,
    endedAt: chat.endedAt,
    messages: chat.messages.map((m) => ({
      id: m.id,
      role: m.role,
      body: m.body,
      options: m.options ? (JSON.parse(m.options) as BotOption[]) : [],
      createdAt: m.createdAt,
    })),
  };
}

async function assertOwn(chatId: string, userId: string) {
  const chat = await prisma.supportChat.findFirst({
    where: { id: chatId, userId },
  });
  if (!chat) throw new ApiError(404, "Chat not found");
  return chat;
}

// ---------- start ----------
supportRouter.post(
  "/chats",
  chatLimiter,
  validateBody(
    z.object({
      topic: z.string().trim().max(60).optional(),
      orderId: z.string().cuid().optional(),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const { topic, orderId } = req.body as { topic?: string; orderId?: string };

      // An order can only be attached if it belongs to the caller.
      if (orderId) {
        const owned = await prisma.order.findFirst({
          where: { id: orderId, userId: req.userId! },
          select: { id: true },
        });
        if (!owned) throw new ApiError(404, "Order not found");
      }

      const opening = await greet(req.userId!, topic);
      const chat = await prisma.supportChat.create({
        data: {
          userId: req.userId!,
          topic: opening.topic ?? topic ?? null,
          orderId: orderId ?? opening.orderId ?? null,
          messages: {
            create: {
              role: "bot",
              body: opening.body,
              options: JSON.stringify(opening.options),
            },
          },
        },
        select: { id: true },
      });
      res.status(201).json({ chat: await serialise(chat.id) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- read ----------
supportRouter.get("/chats", async (req, res, next) => {
  try {
    const chats = await prisma.supportChat.findMany({
      where: { userId: req.userId! },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        id: true,
        topic: true,
        status: true,
        startedAt: true,
        endedAt: true,
        ratingStars: true,
      },
    });
    res.json({ chats });
  } catch (err) {
    next(err);
  }
});

supportRouter.get("/chats/:id", async (req, res, next) => {
  try {
    await assertOwn(req.params.id!, req.userId!);
    res.json({ chat: await serialise(req.params.id!) });
  } catch (err) {
    next(err);
  }
});

// ---------- send a message ----------
supportRouter.post(
  "/chats/:id/messages",
  chatLimiter,
  validateBody(z.object({ body: z.string().trim().min(1).max(1000) }).strict()),
  async (req, res, next) => {
    try {
      const chat = await assertOwn(req.params.id!, req.userId!);
      if (chat.status === "closed") {
        throw new ApiError(409, "This conversation has been closed");
      }
      const { body } = req.body as { body: string };

      await prisma.supportMessage.create({
        data: { chatId: chat.id, role: "user", body },
      });

      const reply = await respond({
        userId: req.userId!,
        text: body,
        currentTopic: chat.topic,
        currentOrderId: chat.orderId,
      });

      await prisma.supportMessage.create({
        data: {
          chatId: chat.id,
          role: "bot",
          body: reply.body,
          options: JSON.stringify(reply.options),
        },
      });

      // The assistant handing over is what raises the ticket — the customer
      // never has to fill a form to reach a person.
      let ticketId = chat.ticketId;
      // Claimed before the ticket is raised, and only while the chat is not
      // already escalated. Two requests asking for a person at once both saw
      // no ticket and both raised one, so the team saw the case twice.
      const claimedEscalation =
        reply.escalate && !ticketId
          ? (
              await prisma.supportChat.updateMany({
                where: { id: chat.id, ticketId: null, status: { not: "escalated" } },
                data: { status: "escalated" },
              })
            ).count === 1
          : false;
      if (claimedEscalation) {
        const transcript = await prisma.supportMessage.findMany({
          where: { chatId: chat.id },
          orderBy: { createdAt: "asc" },
          select: { role: true, body: true },
        });
        const created = await createTicket({
          userId: req.userId!,
          ...(chat.orderId ? { orderId: chat.orderId } : {}),
          category: "other",
          subject: chat.topic
            ? `Help Centre: ${chat.topic}`
            : "Help Centre conversation",
          // The whole conversation goes with it so the agent has the context
          // the customer already gave.
          body: transcript
            .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.body}`)
            .join("\n\n")
            .slice(0, 2000),
        });
        if (created.ok) ticketId = created.ticket.id;
      }

      await prisma.supportChat.update({
        where: { id: chat.id },
        data: {
          ...(reply.topic ? { topic: reply.topic } : {}),
          ...(reply.orderId ? { orderId: reply.orderId } : {}),
          ...(ticketId ? { ticketId } : {}),
          ...(reply.escalate
            ? { status: "escalated" }
            : reply.resolved
              ? { status: "resolved", endedAt: new Date() }
              : {}),
        },
      });

      res.json({
        chat: await serialise(chat.id),
        // The client uses these to know when to show the rating card.
        resolved: !!reply.resolved,
        escalated: !!reply.escalate,
        ticketId: ticketId ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------- end ----------
// Ending always leads to the rating prompt; that is the point of separating it
// from "closed", which is the state after the rating is in (or declined).
supportRouter.post("/chats/:id/end", async (req, res, next) => {
  try {
    const chat = await assertOwn(req.params.id!, req.userId!);
    if (chat.endedAt) return res.json({ chat: await serialise(chat.id) });
    await prisma.supportChat.update({
      where: { id: chat.id },
      data: {
        status: chat.status === "escalated" ? "escalated" : "resolved",
        endedAt: new Date(),
      },
    });
    res.json({ chat: await serialise(chat.id) });
  } catch (err) {
    next(err);
  }
});

// ---------- rating ----------
supportRouter.post(
  "/chats/:id/rating",
  validateBody(
    z.object({
      stars: z.number().int().min(1).max(5),
      comment: z.string().trim().max(500).optional(),
    }).strict(),
  ),
  async (req, res, next) => {
    try {
      const chat = await assertOwn(req.params.id!, req.userId!);
      if (chat.ratedAt) throw new ApiError(409, "You've already rated this chat");
      const { stars, comment } = req.body as { stars: number; comment?: string };

      // Only while still unrated. A second tap at the same moment passed the
      // check above, overwrote the first rating and raised a second ticket.
      const rated = await prisma.supportChat.updateMany({
        where: { id: chat.id, ratedAt: null },
        data: {
          ratingStars: stars,
          ratingComment: comment ?? null,
          ratedAt: new Date(),
          // Rating is the last act; the conversation is done after it.
          status: "closed",
          endedAt: chat.endedAt ?? new Date(),
        },
      });
      if (rated.count === 0) throw new ApiError(409, "You've already rated this chat");

      // A poor rating on a conversation the assistant thought it had solved is
      // the clearest signal we have that it didn't. Raise it for a human rather
      // than filing the complaint away in a metric.
      if (stars <= 2 && !chat.ticketId) {
        const created = await createTicket({
          userId: req.userId!,
          ...(chat.orderId ? { orderId: chat.orderId } : {}),
          category: "other",
          subject: `Low Help Centre rating (${stars}★)`,
          body:
            (comment?.trim() ? `${comment.trim()}\n\n` : "") +
            `The customer rated a Help Centre chat ${stars} out of 5. Chat id ${chat.id}.`,
        });
        if (created.ok) {
          await prisma.supportChat.update({
            where: { id: chat.id },
            data: { ticketId: created.ticket.id },
          });
        }
      }

      res.json({ chat: await serialise(chat.id) });
    } catch (err) {
      next(err);
    }
  },
);
