import { prisma } from "../../lib/prisma.js";
import { matchTopic, topicBySlug, type SupportTopic } from "./support.kb.js";
import { istDateLabel } from "../../lib/istTime.js";
import { completeDueOrders } from "../orders/lifecycle.js";

/** Integer paise in, display rupees out — the server has no shared helper. */
const rupeesFromPaise = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// The Help Centre assistant.
//
// Deterministic on purpose. A support surface has to give the same answer to
// the same question every time, has to work with no model API key configured,
// and must never be steerable by a customer typing instructions into it — all
// three rule out a free-form model here. What makes it useful instead of a FAQ
// dump is that it reads the customer's own orders, refunds and complaints, so
// "where is my order" gets answered with their order rather than with advice.
//
// It never claims to have done something it cannot do. Where the app has no
// mechanism (changing a sign-in address, tracing a bank hold), it says a person
// has to take it and offers the handover.

export type BotOption = { label: string; value: string };
export type BotReply = {
  body: string;
  options: BotOption[];
  /** Topic the conversation is now about, stored on the chat. */
  topic?: string;
  /** Order the conversation settled on. */
  orderId?: string;
  /** The assistant believes this is finished. */
  resolved?: boolean;
  /** Needs a human; the caller raises the ticket. */
  escalate?: boolean;
};

const ORDER_STATUS_TEXT: Record<string, string> = {
  pending_payment: "waiting for payment",
  confirmed: "confirmed and being prepared",
  in_progress: "on its way",
  completed: "completed",
  cancelled: "cancelled",
};

/** The two options offered at the end of nearly every answer. */
function closingOptions(): BotOption[] {
  return [
    { label: "That solved it", value: "__resolved" },
    { label: "Talk to a person", value: "__escalate" },
  ];
}

async function recentOrders(userId: string) {
  // Finished first, or an order whose screen was closed early is greeted as
  // live weeks later.
  await completeDueOrders(userId);
  return prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      title: true,
      status: true,
      amount: true,
      domain: true,
      createdAt: true,
    },
  });
}

/** A short, human line describing one order. */
function describeOrder(o: {
  title: string;
  status: string;
  amount: number;
  createdAt: Date;
}) {
  const when = istDateLabel(o.createdAt, { day: "numeric", month: "short" });
  return `${o.title} (${when}, ${rupeesFromPaise(o.amount)}), ${ORDER_STATUS_TEXT[o.status] ?? o.status}`;
}

/**
 * Answers a topic using what is actually true of this account right now.
 * Falls back to the written article when there is nothing account-specific to
 * add, which is the honest outcome for a general question.
 */
async function answerWithContext(
  userId: string,
  topic: SupportTopic,
  orderId?: string | null,
): Promise<BotReply> {
  const lines: string[] = [];

  if (topic.needsOrder) {
    const orders = await recentOrders(userId);
    const chosen = orderId
      ? orders.find((o) => o.id === orderId)
      : orders[0];

    if (!chosen) {
      lines.push(
        "I can't see any orders on this account yet, so there's nothing for me to look up here.",
      );
      if (topic.article[0]) lines.push(topic.article[0]);
      return { body: lines.join("\n\n"), options: closingOptions(), topic: topic.slug };
    }

    lines.push(`Your most recent one is ${describeOrder(chosen)}.`);

    // Say something true about THIS order's state rather than generic advice.
    if (topic.slug === "order-late") {
      if (chosen.status === "completed") {
        lines.push(
          "That one is already marked completed. If it never actually reached you, tell me and I'll treat it as a missing delivery instead.",
        );
      } else if (chosen.status === "cancelled") {
        lines.push("That order was cancelled, so nothing is on its way.");
      } else if (chosen.status === "pending_payment") {
        lines.push(
          "Payment hasn't completed on it, so it hasn't been sent to the restaurant yet. Finishing the payment will start it.",
        );
      } else {
        lines.push(
          "It's still live, so the tracking screen on the order has the current stage and arrival time.",
        );
      }
    }

    if (topic.slug === "cancel-order") {
      if (chosen.status === "completed" || chosen.status === "cancelled") {
        lines.push(
          `That order is already ${chosen.status}, so there's nothing left to cancel.`,
        );
      } else {
        lines.push(
          "You can cancel it from the order screen. If the restaurant has already handed it to a delivery partner, the app will refuse and tell you so.",
        );
      }
    }

    if (topic.slug === "refund-status") {
      const refund = await prisma.complaintRefund.findFirst({
        where: { complaint: { userId } },
        orderBy: { initiatedAt: "desc" },
        select: { amountPaise: true, status: true, completedAt: true },
      });
      const payment = await prisma.payment.findFirst({
        where: { orderId: chosen.id },
        select: { status: true },
      });
      if (refund) {
        lines.push(
          refund.completedAt
            ? `Your most recent refund of ${rupeesFromPaise(refund.amountPaise)} is marked completed on our side. If your bank hasn't posted it, that's the 3 to 5 working day window.`
            : `Your most recent refund of ${rupeesFromPaise(refund.amountPaise)} is ${refund.status}. Once it's released, the bank takes 3 to 5 working days.`,
        );
      } else if (payment?.status === "refund_pending" || payment?.status === "refund_processing") {
        lines.push(
          "A refund has been started for that order and hasn't settled yet. Banks take 3 to 5 working days once it's released.",
        );
      } else {
        lines.push("I can't see a refund in progress on this account.");
      }
    }

    const article = topic.article[1] ?? topic.article[0];
    if (article) lines.push(article);

    return {
      body: lines.join("\n\n"),
      options: topic.alwaysEscalate
        ? [{ label: "Raise this with a person", value: "__escalate" }, ...closingOptions().slice(0, 1)]
        : closingOptions(),
      topic: topic.slug,
      orderId: chosen.id,
    };
  }

  // No account data needed — answer from the article.
  if (topic.article[0]) lines.push(topic.article[0]);
  if (topic.article[1]) lines.push(topic.article[1]);
  return {
    body: lines.join("\n\n"),
    options: topic.alwaysEscalate
      ? [{ label: "Raise this with a person", value: "__escalate" }, ...closingOptions().slice(0, 1)]
      : closingOptions(),
    topic: topic.slug,
  };
}

/** The assistant's opening message. */
export async function greet(userId: string, topicSlug?: string | null): Promise<BotReply> {
  if (topicSlug) {
    const topic = topicBySlug(topicSlug);
    if (topic) return answerWithContext(userId, topic);
  }

  const orders = await recentOrders(userId);
  const live = orders.find(
    (o) => o.status === "confirmed" || o.status === "in_progress",
  );

  const options: BotOption[] = [];
  if (live) options.push({ label: "About my current order", value: "order-late" });
  options.push(
    { label: "Refund or payment", value: "refund-status" },
    { label: "Offers and rewards", value: "coupon-not-applied" },
    { label: "Account and login", value: "otp-not-received" },
    { label: "Something else", value: "__escalate" },
  );

  const body = live
    ? `Hi. I can see a live order: ${describeOrder(live)}. What can I help with?`
    : "Hi. I'm the Flouna Help Centre assistant. Tell me what's wrong, or pick one of these.";

  return { body, options };
}

/**
 * Handles one customer message.
 *
 * `text` is either free text or the `value` of a quick reply, which is why the
 * control values are prefixed with __ — a customer typing "resolved" should not
 * be able to trip the control path.
 */
export async function respond(opts: {
  userId: string;
  text: string;
  currentTopic?: string | null;
  currentOrderId?: string | null;
}): Promise<BotReply> {
  const text = opts.text.trim();

  if (text === "__resolved") {
    return {
      body: "Good to hear. I'll close this off, you'll get a quick rating prompt so we know how it went.",
      options: [],
      resolved: true,
    };
  }

  if (text === "__escalate") {
    return {
      body: "I'll pass this to a person. They'll pick it up with the whole conversation attached, so you won't have to repeat any of it.",
      options: [],
      escalate: true,
    };
  }

  // A quick reply carrying a topic slug.
  const picked = topicBySlug(text);
  if (picked) return answerWithContext(opts.userId, picked, opts.currentOrderId);

  // Free text.
  const matched = matchTopic(text);
  if (matched) return answerWithContext(opts.userId, matched, opts.currentOrderId);

  // Nothing recognised. Say so plainly rather than guessing, and offer the
  // handover — an assistant that invents an answer on a support screen is worse
  // than one that admits the limit.
  return {
    body: "I haven't understood that one well enough to answer it properly. Try describing it in a few more words, or I can pass you to a person who can look at the account directly.",
    options: [
      { label: "Talk to a person", value: "__escalate" },
      { label: "My order", value: "order-late" },
      { label: "A refund", value: "refund-status" },
    ],
  };
}
