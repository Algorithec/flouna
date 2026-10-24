import { randomBytes } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { GRIEVANCE_SLA } from "../../lib/policy.js";
import { ApiError } from "../../middleware/error.js";
import { enqueueNotification } from "../notifications/outbox.service.js";
import { igmAdapter } from "./igm.adapter.js";

// ONDC IGM 2.0 complaint service.
//
// Owns the case: creation, the customer-visible state machine, and the action
// trail that ONDC asks to see during the live walkthrough. It deliberately
// knows nothing about protocol payloads — the adapter maps to and from the wire
// so a spec change lands in one place.

/** Customer-visible states. Kept small on purpose; the detail lives in actions. */
export const COMPLAINT_STATUSES = [
  "OPEN",
  "PROCESSING",
  // Written by the grievance console when the one internal appeal is opened,
  // and shown to the customer as its own label. It was missing from this list
  // and from RANK below, which is what let a case get stuck: see RANK.
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/**
 * Action codes for the audit trail. Richer than the four UI states by design —
 * flattening protocol events into the status column would destroy the trail
 * ONDC needs to inspect.
 *
 * These are OUR internal vocabulary. The ONDC-controlled action codes are
 * whatever the live spec defines; the adapter translates between them, and none
 * of them are invented here.
 */
export const ACTION_CODES = [
  "CREATED",
  "ACKNOWLEDGED",
  "INFO_REQUESTED",
  "INFO_PROVIDED",
  "RESOLUTION_PROPOSED",
  "RESOLUTION_ACCEPTED",
  "RESOLUTION_REJECTED",
  "ESCALATED",
  "REFUND_INITIATED",
  "REFUND_COMPLETED",
  "STATUS_REQUESTED",
  // The seller says it has carried out the resolution. Distinct from the
  // customer accepting one, which is a promise, not a delivery.
  "RESOLVED",
  "CLOSED",
] as const;
export type ActionCode = (typeof ACTION_CODES)[number];

export const ACTOR_TYPES = [
  "CONSUMER",
  "INTERFACING-NP",
  "SELLER-NP",
  "GRO",
  "ONDC",
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Which states an action may move the case to.
 *
 * Anything not listed records the action without touching status — a seller
 * asking for information is real history but does not move a case out of
 * PROCESSING, and a rejected resolution must not look like progress.
 */
const STATUS_AFTER: Partial<Record<ActionCode, ComplaintStatus>> = {
  CREATED: "OPEN",
  ACKNOWLEDGED: "PROCESSING",
  INFO_REQUESTED: "PROCESSING",
  INFO_PROVIDED: "PROCESSING",
  RESOLUTION_PROPOSED: "PROCESSING",
  RESOLUTION_ACCEPTED: "RESOLVED",
  RESOLVED: "RESOLVED",
  ESCALATED: "PROCESSING",
  CLOSED: "CLOSED",
};

/**
 * Never move backwards: a resolved case isn't reopened by a late callback.
 *
 * ESCALATED ranks alongside PROCESSING. It used to be absent entirely, so an
 * appealed case compared every incoming action against `undefined` — and
 * `RANK[target] > undefined` is false for every target. The status machine had
 * no exit: a seller's RESOLUTION_ACCEPTED or a CLOSED callback arriving after
 * an appeal was opened recorded its action and left the case ESCALATED for
 * ever, with resolvedAt and closedAt never set and the grievance queue still
 * counting it as owed.
 */
const RANK: Record<ComplaintStatus, number> = {
  OPEN: 0,
  PROCESSING: 1,
  ESCALATED: 1,
  RESOLVED: 2,
  CLOSED: 3,
};

/**
 * Human-readable, customer-safe sentence for each action.
 *
 * The guide is explicit that raw protocol JSON must never reach the customer,
 * so the trail is written in plain language at the point it is recorded.
 */
const DEFAULT_DESCRIPTION: Record<ActionCode, string> = {
  CREATED: "Complaint raised",
  ACKNOWLEDGED: "Received by the seller",
  INFO_REQUESTED: "Seller asked for more information",
  INFO_PROVIDED: "You sent the requested information",
  RESOLUTION_PROPOSED: "Seller proposed a resolution",
  RESOLUTION_ACCEPTED: "You accepted a resolution",
  RESOLUTION_REJECTED: "You rejected a resolution",
  ESCALATED: "Complaint escalated",
  REFUND_INITIATED: "Refund started",
  REFUND_COMPLETED: "Refund completed",
  STATUS_REQUESTED: "Status update requested",
  RESOLVED: "Seller marked the complaint resolved",
  CLOSED: "Complaint closed",
};

/**
 * ALG-000123 — the reference the customer quotes and the issue id we send.
 *
 * Derived from the highest code already issued, not from how many rows exist.
 * A count has two faults on a UNIQUE column: two complaints raised at the same
 * moment both counted the same number and the second insert failed, so a
 * double tap on Raise Complaint lost one of them to a 500; and once any
 * complaint was ever deleted the count fell back onto a code already taken,
 * which wedges every subsequent complaint rather than one.
 */
async function nextComplaintCode(): Promise<string> {
  const latest = await prisma.complaint.findFirst({
    where: { code: { startsWith: "ALG-" } },
    orderBy: { code: "desc" },
    select: { code: true },
  });
  const highest = Number(latest?.code.slice(4)) || 0;
  return `ALG-${String(highest + 1).padStart(6, "0")}`;
}

/**
 * Append to the audit trail and advance the case if the action implies it.
 *
 * `actionId` is the idempotency key. A network callback that arrives twice —
 * which the guide warns to expect — records once, and the second attempt is a
 * no-op rather than a duplicate action or a second refund.
 */
export async function recordAction(input: {
  complaintId: string;
  code: ActionCode;
  description?: string;
  actionBy: ActorType;
  actorId?: string;
  /** Supply the protocol's action id for inbound events; generated otherwise. */
  actionId?: string;
}) {
  const complaint = await prisma.complaint.findUnique({
    where: { id: input.complaintId },
    select: { id: true, status: true },
  });
  if (!complaint) throw new ApiError(404, "Complaint not found");

  // A millisecond is not unique enough to key our own actions on.
  //
  // actionId is the idempotency key, and an id built from the clock alone
  // collided whenever two actions landed in the same millisecond — which the
  // accept path does on purpose, recording RESOLUTION_ACCEPTED and then
  // REFUND_INITIATED back to back. The second was treated as a duplicate
  // delivery and silently dropped, so the customer's timeline lost the line
  // saying their refund had started. Random bytes make our own ids unique;
  // an id supplied by the protocol is still used exactly as given, because
  // that is the one that has to deduplicate a repeated callback.
  const actionId =
    input.actionId ??
    `ACT-${input.complaintId.slice(-6)}-${Date.now()}-${randomBytes(4).toString("hex")}`;

  const existing = await prisma.complaintAction.findUnique({
    where: { actionId },
    select: { id: true },
  });
  if (existing) return { action: existing, deduped: true as const };

  // Chain to the previous action so the case replays in order.
  const previous = await prisma.complaintAction.findFirst({
    where: { complaintId: input.complaintId },
    orderBy: { createdAt: "desc" },
    select: { actionId: true },
  });

  const action = await prisma.complaintAction.create({
    data: {
      complaintId: input.complaintId,
      actionId,
      code: input.code,
      description: input.description ?? DEFAULT_DESCRIPTION[input.code],
      actionBy: input.actionBy,
      actorId: input.actorId,
      lastActionId: previous?.actionId,
    },
  });

  const target = STATUS_AFTER[input.code];
  if (target && RANK[target] > RANK[complaint.status as ComplaintStatus]) {
    await prisma.complaint.update({
      where: { id: complaint.id },
      data: {
        status: target,
        ...(target === "RESOLVED" ? { resolvedAt: new Date() } : {}),
        ...(target === "CLOSED" ? { closedAt: new Date() } : {}),
      },
    });
  }

  return { action, deduped: false as const };
}

/**
 * Raise a complaint against one of the caller's own orders.
 *
 * Creates the case, its two known actors, and the opening action. The issue is
 * not transmitted here — that is the adapter's job, kept separate so a network
 * outage can never block a customer from filing.
 */
export async function createComplaint(input: {
  userId: string;
  orderId?: string;
  fulfillmentId?: string;
  itemIds?: string[];
  category: string;
  subCategory?: string;
  description: string;
}) {
  if (input.orderId) {
    // Never let someone raise a complaint against an order that isn't theirs.
    // The order may be an app order, a food order with an ONDC seller, or a
    // ride with an ONDC provider; each is checked against its owner.
    const where = { id: input.orderId, userId: input.userId };
    const owned =
      (await prisma.order.findFirst({ where, select: { id: true } })) ??
      (await prisma.ondcOrder.findFirst({ where, select: { id: true } })) ??
      (await prisma.ondcRide.findFirst({ where, select: { id: true } }));
    if (!owned) throw new ApiError(404, "Order not found");
  }

  // The deadlines the support policy publishes for a grievance, stamped when
  // the case opens. Written down rather than worked out later, so a change to
  // the policy cannot move a commitment already made to this customer, and so
  // "are we late" is a question the row can answer by itself.
  const now = Date.now();

  const data = {
    userId: input.userId,
    orderId: input.orderId,
    fulfillmentId: input.fulfillmentId,
    itemIds: JSON.stringify(input.itemIds ?? []),
    category: input.category,
    subCategory: input.subCategory,
    description: input.description,
    status: "OPEN",
    assignBy: new Date(now + GRIEVANCE_SLA.assignMs),
    contactBy: new Date(now + GRIEVANCE_SLA.contactMs),
    investigateBy: new Date(now + GRIEVANCE_SLA.investigateMs),
  };

  // The reference is read and then written, so two complaints raised together
  // can still pick the same one. The unique index stops the second, and
  // without this retry that customer's complaint was simply lost behind a 500.
  let complaint: Awaited<ReturnType<typeof prisma.complaint.create>> | null = null;
  for (let attempt = 0; attempt < 5 && !complaint; attempt++) {
    complaint = await prisma.complaint
      .create({ data: { ...data, code: await nextComplaintCode() } })
      .catch((err: { code?: string }) => {
        if (err?.code !== "P2002") throw err;
        return null;
      });
  }
  if (!complaint) {
    throw new ApiError(503, "We could not file that complaint just now, please try again");
  }

  await prisma.complaintActor.createMany({
    data: [
      {
        complaintId: complaint.id,
        actorId: input.userId,
        actorType: "CONSUMER",
      },
      {
        complaintId: complaint.id,
        actorId: "ALG-BUYER",
        actorType: "INTERFACING-NP",
        name: "Flouna",
      },
    ],
  });

  await recordAction({
    complaintId: complaint.id,
    code: "CREATED",
    actionBy: "CONSUMER",
    actorId: input.userId,
  });

  // The Complaint Submitted screen tells the customer a confirmation email is
  // on its way, so one is actually queued. dedupeKey makes a retried create
  // harmless. Awaited-and-swallowed rather than fire-and-forget: a mail problem
  // must not fail the complaint, but it also must not race the response.
  await enqueueNotification(
    input.userId,
    "complaint.raised",
    { code: complaint.code, complaintId: complaint.id },
    { dedupeKey: `complaint.raised:${complaint.id}` },
  ).catch(() => {});

  // Hand the case to the network. Deliberately after the complaint is durable
  // and swallowed on failure: the customer has filed something real, and an
  // ONDC outage must not lose it. The adapter records what it queued either
  // way, so nothing has to be reconstructed later.
  await igmAdapter.sendIssue(complaint.id).catch(() => {});

  return complaint;
}

/** The customer's own complaints, newest first. */
export async function listComplaints(userId: string) {
  return prisma.complaint.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      code: true,
      status: true,
      category: true,
      subCategory: true,
      orderId: true,
      createdAt: true,
      infoRequestedAt: true,
      resolvedAt: true,
      assignBy: true,
      contactBy: true,
      investigateBy: true,
      assignedAt: true,
      contactedAt: true,
      appealedAt: true,
      appealDueBy: true,
    },
    take: 50,
  });
}

/**
 * Full case for the customer.
 *
 * Protocol messages are excluded deliberately — they hold raw payloads, which
 * the guide says must never be exposed to the app.
 */
export async function getComplaint(userId: string, id: string) {
  const complaint = await prisma.complaint.findFirst({
    where: { id, userId },
    include: {
      actions: { orderBy: { createdAt: "asc" } },
      resolutions: { orderBy: { createdAt: "asc" } },
      refunds: { orderBy: { initiatedAt: "desc" } },
      escalations: { orderBy: { createdAt: "desc" } },
      evidence: {
        select: { id: true, mimeType: true, sizeBytes: true, createdAt: true },
      },
    },
  });
  if (!complaint) throw new ApiError(404, "Complaint not found");

  return {
    ...complaint,
    itemIds: JSON.parse(complaint.itemIds) as string[],
  };
}

/** Customer supplies what the seller asked for. */
export async function provideInformation(
  userId: string,
  id: string,
  message: string,
) {
  const complaint = await prisma.complaint.findFirst({
    where: { id, userId },
    select: { id: true, infoRequestedAt: true },
  });
  if (!complaint) throw new ApiError(404, "Complaint not found");
  if (!complaint.infoRequestedAt) {
    throw new ApiError(400, "No information has been requested");
  }

  await recordAction({
    complaintId: complaint.id,
    code: "INFO_PROVIDED",
    description: message.slice(0, 300),
    actionBy: "CONSUMER",
    actorId: userId,
  });

  await prisma.complaint.update({
    where: { id: complaint.id },
    data: { infoRequestedAt: null, infoRequest: null },
  });

  // Told to the seller after it is recorded here, and never allowed to fail
  // the customer's reply: the adapter records what it held back and why.
  await igmAdapter
    .sendAction(complaint.id, { code: "INFO_PROVIDED", shortDesc: message.slice(0, 300) })
    .catch(() => {});

  return { ok: true };
}

/**
 * Record the customer's decision on a proposed resolution.
 *
 * Accepting does NOT mark money as moved. It records the decision and, for a
 * financial resolution, opens a refund in `initiated` — the refund service is
 * what may later mark it completed, from authoritative data.
 */
export async function decideResolution(
  userId: string,
  complaintId: string,
  resolutionId: string,
  decision: "accepted" | "rejected",
) {
  const complaint = await prisma.complaint.findFirst({
    where: { id: complaintId, userId },
    select: { id: true, orderId: true },
  });
  if (!complaint) throw new ApiError(404, "Complaint not found");

  const resolution = await prisma.complaintResolution.findFirst({
    where: { id: resolutionId, complaintId: complaint.id },
  });
  if (!resolution) throw new ApiError(404, "Resolution not found");
  // Taken by one conditional write rather than a check and then a write. The
  // two steps let a double tap on Accept through twice, opening two refunds
  // for one resolution, and let Accept and Reject pressed together both stand.
  const claimed = await prisma.complaintResolution.updateMany({
    where: { id: resolution.id, customerDecision: null },
    data: { customerDecision: decision, decidedAt: new Date() },
  });
  if (claimed.count === 0) {
    throw new ApiError(409, "This resolution has already been decided");
  }

  await recordAction({
    complaintId: complaint.id,
    code: decision === "accepted" ? "RESOLUTION_ACCEPTED" : "RESOLUTION_REJECTED",
    description:
      decision === "accepted"
        ? `You accepted: ${resolution.description}`
        : `You rejected: ${resolution.description}`,
    actionBy: "CONSUMER",
    actorId: userId,
  });

  await igmAdapter
    .sendAction(complaint.id, {
      code: decision === "accepted" ? "RESOLUTION_ACCEPTED" : "RESOLUTION_REJECTED",
      shortDesc: decision === "accepted" ? "Resolution accepted" : "Resolution rejected",
      resolutionRowId: resolution.id,
    })
    .catch(() => {});

  if (decision === "accepted" && resolution.amountPaise != null) {
    await prisma.complaintRefund.create({
      data: {
        complaintId: complaint.id,
        orderId: complaint.orderId,
        amountPaise: resolution.amountPaise,
        status: "initiated",
      },
    });
    await recordAction({
      complaintId: complaint.id,
      code: "REFUND_INITIATED",
      actionBy: "INTERFACING-NP",
    });
  }

  return { ok: true };
}

/** Escalate to the GRO (level 1) or on to ONDC (level 2). */
export async function escalateComplaint(
  userId: string,
  id: string,
  reason: string,
  fromLevel?: number,
) {
  const complaint = await prisma.complaint.findFirst({
    where: { id, userId },
    select: { id: true, status: true, escalationLevel: true },
  });
  if (!complaint) throw new ApiError(404, "Complaint not found");
  if (complaint.status === "CLOSED") {
    throw new ApiError(400, "This complaint is already closed");
  }
  if (complaint.escalationLevel >= 2) {
    throw new ApiError(400, "This complaint is already at the highest level");
  }

  // A tap escalates from the level the customer was looking at. Without
  // this, the second tap of a double tap that arrived after the first had
  // finished read the new level and escalated again, straight to ONDC.
  const from = fromLevel ?? complaint.escalationLevel;
  if (from !== complaint.escalationLevel) {
    throw new ApiError(409, "This complaint has just been escalated");
  }
  const level = from + 1;
  // The level is claimed before anything is written, and only if it is still
  // the one read above. Two taps at once used to both read level 0, so the
  // complaint went to the grievance officer twice, with two escalation records
  // and two timeline entries.
  const claimed = await prisma.complaint.updateMany({
    where: { id: complaint.id, escalationLevel: from },
    data: { escalationLevel: level, issueType: "GRIEVANCE" },
  });
  if (claimed.count === 0) {
    throw new ApiError(409, "This complaint has just been escalated");
  }
  await prisma.complaintEscalation.create({
    data: {
      complaintId: complaint.id,
      level,
      reason,
      targetActor: level === 1 ? "GRO" : "ONDC",
    },
  });
  await recordAction({
    complaintId: complaint.id,
    code: "ESCALATED",
    description: level === 1 ? "Escalated to the grievance officer" : "Escalated to ONDC",
    actionBy: "CONSUMER",
    actorId: userId,
  });
  await igmAdapter
    .sendAction(complaint.id, { code: "ESCALATED", shortDesc: reason.slice(0, 300) || "Escalated by the customer" })
    .catch(() => {});

  return { level };
}
