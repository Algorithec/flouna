// Support / Issue-&-Grievance tickets. Users raise them (often about an order);
// admins work the queue. Modelled close to ONDC's IGM so the same flow maps onto
// the network's grievance API once we're a registered participant.

import { prisma } from "../../lib/prisma.js";
import { slaFor } from "../../lib/policy.js";

export const TICKET_CATEGORIES = [
  "order",
  "payment",
  "refund",
  "account",
  // A report of something in the app not working, raised from "Report a
  // technical problem" (shake the phone, or Help). Not for abuse or orders.
  "technical",
  "other",
] as const;
/**
 * Maps a ticket category to the row of the published SLA table it answers to.
 *
 * Support policy 3.2 lists seven issue types and the app has five categories,
 * so this is where the two vocabularies meet. Anything unmapped falls to
 * "general", which is the slowest published tier: an unknown issue getting the
 * gentlest deadline is safe, whereas defaulting to the strictest would have us
 * publicly miss a target we never meant to set.
 */
const SLA_ROW: Record<string, string> = {
  order: "order",
  payment: "payment",
  refund: "refund",
  account: "account",
  technical: "general",
  other: "general",
};

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

const PAGE = 25;

// --- User side -----------------------------------------------------------

export async function createTicket(input: {
  userId: string;
  orderId?: string | null;
  category: (typeof TICKET_CATEGORIES)[number];
  subject: string;
  body: string;
}) {
  // If an order is referenced, it must belong to the user — never let someone
  // raise a ticket against an order that isn't theirs.
  if (input.orderId) {
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, userId: input.userId },
      select: { id: true },
    });
    if (!order) return { ok: false as const, reason: "order_not_found" as const };
  }
  // Refund/payment issues skew urgent; everything else is normal by default.
  const priority =
    input.category === "refund" || input.category === "payment" ? "high" : "normal";

  // The deadlines are stamped on now, from the table published in the support
  // policy, rather than worked out when somebody looks at the queue. A promise
  // that is only computed when convenient is a promise nobody is accountable
  // for, and it also means a later edit to the policy cannot move a deadline
  // that was already committed to this customer.
  const sla = slaFor(SLA_ROW[input.category] ?? "general");
  const now = Date.now();

  const ticket = await prisma.supportTicket.create({
    data: {
      userId: input.userId,
      orderId: input.orderId ?? undefined,
      category: input.category,
      subject: input.subject,
      body: input.body,
      priority,
      slaRespondBy: new Date(now + sla.respondMs),
      slaResolveBy: new Date(now + sla.resolveMs),
    },
    select: {
      id: true,
      status: true,
      priority: true,
      createdAt: true,
      slaRespondBy: true,
      slaResolveBy: true,
    },
  });
  return { ok: true as const, ticket };
}

export async function listUserTickets(userId: string) {
  return prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      category: true,
      subject: true,
      status: true,
      priority: true,
      resolution: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

// --- Admin side ----------------------------------------------------------

export async function listTickets(opts: { status?: string; page?: number }) {
  const page = Math.max(1, opts.page ?? 1);
  const where = opts.status ? { status: opts.status } : {};

  const [rows, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      // Open/urgent first, then most recent.
      orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE,
      take: PAGE,
      select: {
        id: true,
        category: true,
        subject: true,
        status: true,
        priority: true,
        orderId: true,
        assigneeId: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.supportTicket.count({ where }),
  ]);
  return { tickets: rows, total, page, pageSize: PAGE };
}

export async function getTicket(id: string) {
  return prisma.supportTicket.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}

export async function updateTicket(
  id: string,
  data: { status?: string; priority?: string; assigneeId?: string | null; resolution?: string },
) {
  // Stamps the two moments the SLA is actually measured against.
  //
  // firstResponseAt is set once and never moved: the published promise is
  // about the first reply, so a second agent picking the ticket up later must
  // not reset a clock that has already been answered. resolvedAt follows the
  // status, and is cleared if a ticket is reopened, because a reopened ticket
  // is by definition not resolved.
  const existing = await prisma.supportTicket
    .findUnique({ where: { id }, select: { firstResponseAt: true, status: true } })
    .catch(() => null);
  if (!existing) return null;

  const touched = data.status !== undefined || data.assigneeId !== undefined;
  const resolving = data.status === "resolved" || data.status === "closed";

  const updated = await prisma.supportTicket
    .update({
      where: { id },
      data: {
        ...data,
        ...(touched && !existing.firstResponseAt ? { firstResponseAt: new Date() } : {}),
        ...(resolving
          ? { resolvedAt: new Date() }
          : data.status !== undefined
            ? { resolvedAt: null }
            : {}),
      },
    })
    .catch(() => null);
  return updated;
}

/**
 * Whether a ticket has missed either published deadline.
 *
 * Read rather than stored, because it changes with the clock and a stored
 * boolean would be wrong within the hour.
 */
export function slaStatus(
  ticket: {
    slaRespondBy: Date | null;
    slaResolveBy: Date | null;
    firstResponseAt: Date | null;
    resolvedAt: Date | null;
  },
  now = new Date(),
) {
  const responseBreached = Boolean(
    ticket.slaRespondBy && !ticket.firstResponseAt && now > ticket.slaRespondBy,
  );
  const resolutionBreached = Boolean(
    ticket.slaResolveBy && !ticket.resolvedAt && now > ticket.slaResolveBy,
  );
  return { responseBreached, resolutionBreached };
}
