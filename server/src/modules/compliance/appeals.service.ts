// Challenging what the decision engine chose.
//
// AI policy 2.5 gives a route to disagree with a recommendation and have it
// reviewed within five business days. 2.6 is the one with legal weight: a
// person may require that a human looks at a decision made about them by an
// automated system, and may not be forced to accept the automated answer.
//
// That second right is why `humanReviewRequested` is stored rather than
// inferred. An appeal answered by the same ranking code that produced the
// decision is not a human review, however good the answer is, and the only way
// to keep that honest is to record that a human was asked for and refuse to
// let anything automated close it.

import { prisma } from "../../lib/prisma.js";
import { addBusinessDays, AI_APPEAL_REVIEW_DAYS } from "../../lib/policy.js";

/** What the person wanted instead. Matches the examples in AI policy 2.5. */
export const APPEAL_WANTED = [
  "cheaper",
  "faster",
  "better_rated",
  "different_seller",
  "wrong_price",
  "unavailable",
  "other",
] as const;

export type AppealWanted = (typeof APPEAL_WANTED)[number];

export async function fileAppeal(input: {
  userId: string;
  decisionLogId?: string | null;
  orderId?: string | null;
  reason: string;
  wanted?: AppealWanted | null;
  humanReview?: boolean;
}) {
  if (input.orderId) {
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, userId: input.userId },
      select: { id: true },
    });
    if (!order) return { ok: false as const, reason: "order_not_found" as const };
  }

  // The contested ranking has to be one made for this person.
  //
  // The order was checked and this was not, so any decision id could be
  // attached to an appeal — and the whole point of 2.6 is that a reviewer
  // looks at the decision made about the person appealing. An appeal pointing
  // at somebody else's search sends the reviewer to the wrong ranking and
  // records a contested decision against an account that never contested it.
  // There is no foreign key here, so nothing caught it.
  if (input.decisionLogId) {
    const decision = await prisma.decisionLog.findFirst({
      where: { id: input.decisionLogId, userId: input.userId },
      select: { id: true },
    });
    if (!decision) {
      return { ok: false as const, reason: "decision_not_found" as const };
    }
  }

  // Five business days, not five calendar days. Treating them as the same
  // would quietly make the promise stricter than the published one, and the
  // promise we would then miss is our own.
  const dueBy = addBusinessDays(new Date(), AI_APPEAL_REVIEW_DAYS);

  const appeal = await prisma.decisionAppeal.create({
    data: {
      userId: input.userId,
      decisionLogId: input.decisionLogId ?? undefined,
      orderId: input.orderId ?? undefined,
      reason: input.reason,
      wanted: input.wanted ?? undefined,
      humanReviewRequested: Boolean(input.humanReview),
      dueBy,
    },
    select: {
      id: true,
      status: true,
      dueBy: true,
      humanReviewRequested: true,
      createdAt: true,
    },
  });
  return { ok: true as const, appeal };
}

export async function listAppeals(userId: string) {
  return prisma.decisionAppeal.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderId: true,
      reason: true,
      wanted: true,
      humanReviewRequested: true,
      status: true,
      dueBy: true,
      response: true,
      respondedAt: true,
      createdAt: true,
    },
  });
}

/**
 * Answers an appeal.
 *
 * `reviewerId` is required and there is no automated path to this function.
 * Where a human review was asked for, closing the appeal without a named
 * reviewer would break the specific commitment in 2.6, so it is refused rather
 * than defaulted: a system account standing in for a person is precisely the
 * thing that right exists to prevent.
 */
export async function answerAppeal(input: {
  appealId: string;
  reviewerId: string;
  response: string;
}) {
  if (!input.reviewerId.trim()) {
    return { ok: false as const, reason: "reviewer_required" as const };
  }
  const appeal = await prisma.decisionAppeal
    .update({
      where: { id: input.appealId },
      data: {
        status: "answered",
        reviewerId: input.reviewerId,
        response: input.response,
        respondedAt: new Date(),
      },
      select: { id: true, status: true, respondedAt: true },
    })
    .catch(() => null);
  if (!appeal) return { ok: false as const, reason: "not_found" as const };
  return { ok: true as const, appeal };
}

/** Appeals past their published review date and still unanswered. */
export async function overdueAppeals(now = new Date()) {
  return prisma.decisionAppeal.findMany({
    where: { status: { in: ["open", "reviewing"] }, dueBy: { lt: now } },
    orderBy: { dueBy: "asc" },
    select: {
      id: true,
      userId: true,
      dueBy: true,
      humanReviewRequested: true,
      createdAt: true,
    },
  });
}

/**
 * The operator's view of the appeal queue.
 *
 * Sorted by deadline rather than by arrival, and appeals where a human review
 * was explicitly asked for come first among equals. That request is the one
 * with legal weight behind it, so it should not sit behind a pile of ordinary
 * feedback simply because it arrived later.
 */
export async function listAppealsForOps(opts: { openOnly?: boolean } = {}) {
  const rows = await prisma.decisionAppeal.findMany({
    where: opts.openOnly === false ? {} : { status: { in: ["open", "reviewing"] } },
    orderBy: { dueBy: "asc" },
    take: 200,
    select: {
      id: true,
      reason: true,
      wanted: true,
      humanReviewRequested: true,
      status: true,
      dueBy: true,
      orderId: true,
      response: true,
      respondedAt: true,
      reviewerId: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  const now = Date.now();
  return rows
    .map((r) => ({ ...r, overdue: !r.respondedAt && r.dueBy.getTime() < now }))
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.humanReviewRequested !== b.humanReviewRequested) {
        return a.humanReviewRequested ? -1 : 1;
      }
      return a.dueBy.getTime() - b.dueBy.getTime();
    });
}
