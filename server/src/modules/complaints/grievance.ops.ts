// Working a grievance, from the operator's side.
//
// The complaint screens already handle the ONDC protocol traffic. This is the
// other half of the same case: the four things the support policy promises a
// person, each with a deadline, and none of which the console could do.
//
//   assigned to an officer   within 48 hours
//   officer makes contact    within 5 days
//   investigation concludes  within 30 days
//   an appeal is decided     within 15 days
//
// Every action here stamps the moment it happened, because a deadline you
// cannot show you met is a deadline you cannot prove you met. The queue is
// then just those stamps read back in order of urgency.

import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../middleware/error.js";
import { GRIEVANCE_SLA } from "../../lib/policy.js";

/** The stamps and deadlines a queue row needs. Nothing about the customer. */
const QUEUE_SELECT = {
  id: true,
  code: true,
  status: true,
  category: true,
  subCategory: true,
  orderId: true,
  createdAt: true,
  resolvedAt: true,
  assignBy: true,
  contactBy: true,
  investigateBy: true,
  assignedAt: true,
  contactedAt: true,
  officerId: true,
  appealedAt: true,
  appealDueBy: true,
  appealOutcome: true,
  user: { select: { id: true, name: true, email: true } },
} as const;

type QueueRow = {
  assignBy: Date | null;
  contactBy: Date | null;
  investigateBy: Date | null;
  assignedAt: Date | null;
  contactedAt: Date | null;
  resolvedAt: Date | null;
  appealDueBy: Date | null;
  appealOutcome: string | null;
};

/**
 * The next thing owed on a case, and when it is owed by.
 *
 * One deadline at a time on purpose. Showing an operator all four at once
 * makes them read four dates and work out which matters; showing the next one
 * makes the queue sortable and the answer obvious.
 */
export function nextObligation(g: QueueRow, now = new Date()) {
  const step = (label: string, due: Date | null) => ({
    label,
    due,
    overdue: Boolean(due && now > due),
  });

  if (g.appealDueBy && !g.appealOutcome) return step("Decide appeal", g.appealDueBy);
  if (!g.assignedAt) return step("Assign an officer", g.assignBy);
  if (!g.contactedAt) return step("Contact the customer", g.contactBy);
  if (!g.resolvedAt) return step("Conclude the investigation", g.investigateBy);
  return { label: "Nothing outstanding", due: null, overdue: false };
}

/**
 * The queue, most urgent first.
 *
 * Sorted by what is owed soonest rather than by when the case arrived. A queue
 * ordered by arrival quietly lets an old case with 20 days left outrank a new
 * one due this afternoon, which is exactly how a published deadline gets
 * missed by people who were working hard the whole time.
 *
 * Cases with nothing outstanding sink to the bottom rather than disappearing,
 * because "did we actually finish that one" is a question worth being able to
 * answer without changing a filter.
 */
export async function grievanceQueue(opts: { includeSettled?: boolean } = {}) {
  const rows = await prisma.complaint.findMany({
    where: opts.includeSettled ? {} : { OR: [{ resolvedAt: null }, { appealedAt: { not: null }, appealOutcome: null }] },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: QUEUE_SELECT,
  });

  const now = new Date();
  return rows
    .map((r) => ({ ...r, next: nextObligation(r, now) }))
    .sort((a, b) => {
      // Overdue first, then soonest due, then anything settled.
      if (a.next.overdue !== b.next.overdue) return a.next.overdue ? -1 : 1;
      if (a.next.due && b.next.due) return a.next.due.getTime() - b.next.due.getTime();
      if (a.next.due) return -1;
      if (b.next.due) return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
}

async function mustExist(id: string) {
  const c = await prisma.complaint.findUnique({
    where: { id },
    select: { id: true, status: true, resolvedAt: true, appealedAt: true, appealOutcome: true },
  });
  if (!c) throw new ApiError(404, "Complaint not found");
  return c;
}

/**
 * Assigns a grievance officer.
 *
 * assignedAt is set once and never moved. The published promise is about being
 * assigned within 48 hours, so reassigning a case later to a different officer
 * must not restart a clock that was already answered, or every handover would
 * silently erase a missed deadline.
 */
export async function assignOfficer(id: string, officerId: string) {
  const existing = await mustExist(id);
  const current = await prisma.complaint.findUnique({
    where: { id: existing.id },
    select: { assignedAt: true },
  });
  return prisma.complaint.update({
    where: { id: existing.id },
    data: {
      officerId,
      ...(current?.assignedAt ? {} : { assignedAt: new Date() }),
      ...(existing.status === "OPEN" ? { status: "PROCESSING" } : {}),
    },
    select: QUEUE_SELECT,
  });
}

/** Records that the officer has made contact. Also set once, for the same reason. */
export async function recordContact(id: string) {
  const existing = await mustExist(id);
  const current = await prisma.complaint.findUnique({
    where: { id: existing.id },
    select: { contactedAt: true, assignedAt: true },
  });
  return prisma.complaint.update({
    where: { id: existing.id },
    data: {
      ...(current?.contactedAt ? {} : { contactedAt: new Date() }),
      // Contact implies assignment. A case contacted but never marked assigned
      // would report an assignment breach forever, which is untrue and would
      // sit at the top of the queue misdirecting whoever is working it.
      ...(current?.assignedAt ? {} : { assignedAt: new Date() }),
    },
    select: QUEUE_SELECT,
  });
}

/** Concludes the investigation. */
export async function concludeGrievance(id: string, outcome: string) {
  const existing = await mustExist(id);
  if (existing.resolvedAt) throw new ApiError(409, "This case is already concluded");
  const current = await prisma.complaint.findUnique({
    where: { id: existing.id },
    select: { assignedAt: true, contactedAt: true },
  });
  const now = new Date();
  // Conditional on still being open: two officers concluding at once used to
  // both succeed, and the second outcome replaced the first unseen.
  await claimOnce(
    prisma.complaint.updateMany({
      where: { id: existing.id, resolvedAt: null },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolution: outcome,
        // Same reasoning as above: concluding a case proves it was assigned and
        // that somebody spoke to the customer.
        ...(current?.assignedAt ? {} : { assignedAt: now }),
        ...(current?.contactedAt ? {} : { contactedAt: now }),
      },
    }),
    "This case is already concluded",
  );
  return prisma.complaint.findUniqueOrThrow({ where: { id: existing.id }, select: QUEUE_SELECT });
}

/** Refuses with a 409 when a conditional write found nothing to change. */
async function claimOnce(write: Promise<{ count: number }>, refusal: string) {
  if ((await write).count === 0) throw new ApiError(409, refusal);
}

/**
 * Opens the one internal appeal, on the customer's behalf.
 *
 * Refuses a second, because the policy says there are no further internal
 * appeals. Accepting one and doing nothing would be worse than saying no.
 */
export async function openAppeal(id: string) {
  const existing = await mustExist(id);
  if (!existing.resolvedAt) {
    throw new ApiError(400, "A case can only be appealed once it is concluded");
  }
  if (existing.appealedAt) {
    throw new ApiError(409, "This case has already been appealed once");
  }
  // Once only: a second request used to push the appeal's deadline later.
  await claimOnce(
    prisma.complaint.updateMany({
      where: { id: existing.id, appealedAt: null },
      data: {
        appealedAt: new Date(),
        appealDueBy: new Date(Date.now() + GRIEVANCE_SLA.appealMs),
        status: "ESCALATED",
      },
    }),
    "This case has already been appealed once",
  );
  return prisma.complaint.findUniqueOrThrow({ where: { id: existing.id }, select: QUEUE_SELECT });
}

/** Decides an appeal. */
export async function decideAppeal(id: string, outcome: string) {
  const existing = await mustExist(id);
  if (!existing.appealedAt) throw new ApiError(400, "This case has not been appealed");
  if (existing.appealOutcome) throw new ApiError(409, "This appeal is already decided");
  await claimOnce(
    prisma.complaint.updateMany({
      where: { id: existing.id, appealOutcome: null },
      data: { appealOutcome: outcome, status: "CLOSED", closedAt: new Date() },
    }),
    "This appeal is already decided",
  );
  return prisma.complaint.findUniqueOrThrow({ where: { id: existing.id }, select: QUEUE_SELECT });
}
