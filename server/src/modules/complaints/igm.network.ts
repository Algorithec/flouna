import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { sendSigned, type SendResult } from "../ondc/transport.js";
import type { SigningIdentity } from "../ondc/signing.js";
import {
  appendIssueAction,
  buildIssue,
  ISSUE_SUBCATEGORY,
  parseOnIssue,
  type IgmActionCode,
  type IgmOrderRef,
} from "../ondc/igm.js";
import { recordAction, type ActionCode } from "./complaints.service.js";

// The complaint model's side of IGM 2.0 over the network: sending a
// complaint to the seller app as an issue, re-sending it as the customer acts
// on it, and applying the seller's on_issue answers to the complaint.

/** Flouna as the interfacing app, as the issue names it. */
export const INTERFACING_CONTACT = {
  name: "Flouna Support",
  phone: "7396144250",
  email: "info@algorithec.com",
};

export type IgmSendOutcome = { sent: boolean; reason?: string };

/** The customer actions the seller is told about, as IGM 2.0 names them. */
export type CustomerIgmAction = {
  code: Extract<IgmActionCode, "INFO_PROVIDED" | "RESOLUTION_ACCEPTED" | "RESOLUTION_REJECTED" | "ESCALATED" | "CLOSED">;
  shortDesc: string;
  /** For a resolution decision, our ComplaintResolution row id. */
  resolutionRowId?: string;
  tags?: unknown[];
};

/**
 * The ONDC details an order carries once it was placed over the network, read
 * from `details.ondc`. Null for every order that was not: those have no seller
 * app to send a complaint to.
 */
export function ondcOrderRef(details: string | null | undefined): IgmOrderRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(details ?? "null");
  } catch {
    return null;
  }
  const o = (parsed as { ondc?: Record<string, unknown> } | null)?.ondc;
  if (!o || typeof o !== "object") return null;
  const bpp = o.bpp as { id?: unknown; uri?: unknown } | undefined;
  const items = Array.isArray(o.items) ? (o.items as { id?: unknown; count?: unknown }[]) : [];
  const strings = [o.transactionId, o.orderId, o.providerId, o.fulfillmentId, o.city, bpp?.id, bpp?.uri];
  if (strings.some((s) => typeof s !== "string" || s.length === 0)) return null;
  if (o.domain !== "ONDC:RET11" && o.domain !== "ONDC:TRV10") return null;
  if (items.some((i) => typeof i.id !== "string" || typeof i.count !== "number")) return null;
  return {
    domain: o.domain,
    city: o.city as string,
    transactionId: o.transactionId as string,
    bpp: { id: bpp!.id as string, uri: bpp!.uri as string },
    orderId: o.orderId as string,
    providerId: o.providerId as string,
    fulfillmentId: o.fulfillmentId as string,
    items: items.map((i) => ({ id: i.id as string, count: i.count as number })),
  };
}

/**
 * The ONDC reference for the order a complaint is about, wherever that order
 * lives: an app order that carries its ONDC details, a food order placed
 * with an ONDC seller (OndcOrder), or a ride booked with an ONDC provider
 * (OndcRide). Only once the seller has accepted it, so there is a seller
 * order id to name; before that there is nothing for the seller to look up.
 */
/** A food order's lines, or null if what is stored does not read as them: the complaint is held, not crashed. */
function cartLines(json: string): { itemId: string; count: number }[] | null {
  try {
    const lines = JSON.parse(json) as unknown;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    const ok = lines.every((l) => typeof (l as { itemId?: unknown }).itemId === "string" && Number.isInteger((l as { count?: unknown }).count));
    return ok ? (lines as { itemId: string; count: number }[]) : null;
  } catch {
    return null;
  }
}

export async function igmRefFor(orderId: string | null | undefined): Promise<IgmOrderRef | null> {
  if (!orderId) return null;
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { details: true } });
  if (order) return ondcOrderRef(order.details);
  const food = await prisma.ondcOrder.findUnique({
    where: { id: orderId },
    select: { sellerOrderId: true, fulfillmentId: true, city: true, txnId: true, bppId: true, bppUri: true, providerId: true, lines: true },
  });
  if (food) {
    // Every field the issue names has to be there, as for a ride: a seller's
    // gateway may drop an issue with an empty one without a word.
    if (!food.sellerOrderId || !food.fulfillmentId || !food.city || !food.txnId || !food.bppId || !food.bppUri || !food.providerId) return null;
    const lines = cartLines(food.lines);
    if (!lines) return null;
    return {
      domain: "ONDC:RET11",
      city: food.city,
      transactionId: food.txnId,
      bpp: { id: food.bppId, uri: food.bppUri },
      orderId: food.sellerOrderId,
      providerId: food.providerId,
      fulfillmentId: food.fulfillmentId,
      items: lines.map((l) => ({ id: l.itemId, count: l.count })),
    };
  }
  const ride = await prisma.ondcRide.findUnique({
    where: { id: orderId },
    select: { sellerOrderId: true, bppId: true, bppUri: true, providerId: true, fulfillmentId: true, itemId: true, city: true, txnId: true },
  });
  if (ride?.sellerOrderId && ride.bppId && ride.bppUri && ride.providerId && ride.fulfillmentId && ride.itemId) {
    return {
      domain: "ONDC:TRV10",
      city: ride.city,
      transactionId: ride.txnId,
      bpp: { id: ride.bppId, uri: ride.bppUri },
      orderId: ride.sellerOrderId,
      providerId: ride.providerId,
      fulfillmentId: ride.fulfillmentId,
      items: [{ id: ride.itemId, count: 1 }],
    };
  }
  return null;
}

type Send = (baseUrl: string, action: string, envelope: { context: Record<string, unknown>; message: unknown }, id: SigningIdentity) => Promise<SendResult>;

export class NetworkIgmAdapter {
  readonly live = true;
  private readonly send: Send;
  private readonly identity: () => SigningIdentity | null;

  constructor(opts: { send?: Send; identity?: () => SigningIdentity | null } = {}) {
    this.send = opts.send ?? ((u, a, e, i) => sendSigned(u, a, e, i));
    this.identity =
      opts.identity ??
      (() =>
        env.ONDC_SUBSCRIBER_ID && env.ONDC_UNIQUE_KEY_ID && env.ONDC_SIGNING_PRIVATE_KEY
          ? { subscriberId: env.ONDC_SUBSCRIBER_ID, uniqueKeyId: env.ONDC_UNIQUE_KEY_ID, signingPrivateKey: env.ONDC_SIGNING_PRIVATE_KEY }
          : null);
  }

  /** Records that nothing went out and why, so the trail says so rather than looking sent. */
  private async held(complaintId: string, action: string, reason: string): Promise<IgmSendOutcome> {
    await prisma.complaintMessage.create({
      data: { complaintId, direction: "outbound", action, payload: JSON.stringify({ held: true, reason }), status: "pending", error: reason },
    });
    return { sent: false, reason };
  }

  private async transmit(complaintId: string, bppUri: string, envelope: { context: Record<string, unknown>; message: unknown }, identity: SigningIdentity) {
    const result = await this.send(bppUri, "issue", envelope, identity);
    await prisma.complaintMessage.create({
      data: {
        complaintId,
        direction: "outbound",
        action: "issue",
        messageId: envelope.context.message_id as string,
        payload: JSON.stringify(envelope),
        status: result.ack ? "acked" : "failed",
        error: result.ack ? null : `Seller app did not acknowledge (HTTP ${result.status})`,
        sentAt: new Date(),
      },
    });
    return result.ack ? { sent: true } : { sent: false, reason: `Seller app did not acknowledge (HTTP ${result.status})` };
  }

  /** Sends a newly raised complaint to the seller app as an issue. */
  async sendIssue(complaintId: string): Promise<IgmSendOutcome> {
    const complaint = await prisma.complaint.findUnique({
      where: { id: complaintId },
      include: { user: { select: { id: true, name: true, email: true, phone: true } }, actions: { orderBy: { createdAt: "asc" }, take: 1 } },
    });
    if (!complaint) return { sent: false, reason: "Complaint not found" };
    const ref = await igmRefFor(complaint.orderId);
    if (!ref) return this.held(complaint.id, "issue", "This order was not placed over ONDC, so there is no seller app to send it to");
    const reason = complaint.subCategory ?? complaint.category;
    if (!ISSUE_SUBCATEGORY[reason]) {
      return this.held(complaint.id, "issue", `"${reason}" has no ONDC issue category; this complaint is handled by Flouna directly`);
    }
    if (!complaint.user.phone) {
      return this.held(complaint.id, "issue", "ONDC needs the customer's phone number on a complaint, and this account has none");
    }
    const identity = this.identity();
    if (!identity) return this.held(complaint.id, "issue", "ONDC signing identity is not configured on this deployment");
    const opened = complaint.actions[0];
    if (!opened) return this.held(complaint.id, "issue", "The complaint has no opening action to send");

    // The issue id is claimed before sending, so a seller's answer that comes
    // back before this request finishes still finds its complaint.
    const issueId = complaint.ondcIssueId ?? crypto.randomUUID();
    await prisma.complaint.update({ where: { id: complaint.id }, data: { ondcIssueId: issueId, ondcTransactionId: ref.transactionId } });

    const envelope = buildIssue({
      ref,
      issueId,
      status: "OPEN",
      createdAt: complaint.createdAt,
      reason,
      description: complaint.description,
      consumer: { id: complaint.user.id, name: complaint.user.name, phone: complaint.user.phone, email: complaint.user.email },
      interfacing: INTERFACING_CONTACT,
      actions: [
        { id: opened.actionId, code: "OPEN", shortDesc: "Complaint created", by: complaint.user.id, byName: complaint.user.name, at: complaint.createdAt },
      ],
    });
    return this.transmit(complaint.id, ref.bpp.uri, envelope, identity);
  }

  /** Re-sends the issue with one of the customer's actions appended. */
  async sendAction(complaintId: string, action: CustomerIgmAction): Promise<IgmSendOutcome> {
    const complaint = await prisma.complaint.findUnique({
      where: { id: complaintId },
      include: { user: { select: { id: true, name: true } } },
    });
    if (!complaint?.ondcIssueId) {
      return { sent: false, reason: "This complaint was not sent over ONDC" };
    }
    const first = await prisma.complaintMessage.findFirst({
      where: { complaintId, direction: "outbound", action: "issue", status: "acked" },
      orderBy: { createdAt: "asc" },
    });
    const latestIn = await prisma.complaintMessage.findFirst({
      where: { complaintId, direction: "inbound", action: "on_issue" },
      orderBy: { createdAt: "desc" },
    });
    if (!first || !latestIn) {
      return this.held(complaintId, "issue", "The seller app has not answered this issue yet, so there is nothing to add to");
    }
    const identity = this.identity();
    if (!identity) return this.held(complaintId, "issue", "ONDC signing identity is not configured on this deployment");

    let refId: string | undefined;
    if (action.resolutionRowId) {
      const row = await prisma.complaintResolution.findUnique({ where: { id: action.resolutionRowId }, select: { resolutionId: true } });
      refId = row ? protocolId(complaintId, row.resolutionId) : undefined;
    }
    const firstEnvelope = JSON.parse(first.payload) as { context: Record<string, unknown> };
    const latestIssue = (JSON.parse(latestIn.payload) as { message?: { issue?: Record<string, unknown> } }).message?.issue ?? {};
    const envelope = appendIssueAction({
      firstContext: firstEnvelope.context,
      latestIssue,
      action: {
        id: `B-${crypto.randomUUID()}`,
        code: action.code,
        shortDesc: action.shortDesc,
        by: complaint.user.id,
        byName: complaint.user.name,
        at: new Date(),
        ...(refId ? { refId, refType: "RESOLUTIONS" } : {}),
        ...(action.tags ? { tags: action.tags } : {}),
      },
    });
    return this.transmit(complaintId, firstEnvelope.context.bpp_uri as string, envelope, identity);
  }
}

// Seller action and resolution ids ("A2", "R1") are only unique within one
// issue, while ours are unique across every complaint. They are stored with
// the complaint's id in front, and the prefix comes off on the way back out.
const scoped = (complaintId: string, id: string) => `${complaintId}:${id}`;
const protocolId = (complaintId: string, stored: string) =>
  stored.startsWith(`${complaintId}:`) ? stored.slice(complaintId.length + 1) : stored;

/** How each seller action shows in the complaint's trail. Codes not listed are kept in the raw log only. */
const SELLER_ACTION: Partial<Record<IgmActionCode, ActionCode>> = {
  OPEN: "ACKNOWLEDGED",
  PROCESSING: "ACKNOWLEDGED",
  INFO_REQUESTED: "INFO_REQUESTED",
  RESOLUTION_PROPOSED: "RESOLUTION_PROPOSED",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
};

/**
 * Applies a verified on_issue to the complaint it answers.
 *
 * Only the seller app the issue was sent to may answer it: the signature
 * proves who sent the message, and this checks that sender against the issue
 * we sent. Everything is idempotent, so the same on_issue applied twice, or a
 * later one repeating earlier actions (as every on_issue does), changes nothing
 * the second time.
 */
export async function applyOnIssue(input: {
  body: Record<string, unknown>;
  raw: string;
  senderId: string;
}): Promise<{ applied: boolean; reason?: string }> {
  const parsed = parseOnIssue(input.body);
  if (!parsed) return { applied: false, reason: "not an issue we can read" };
  const complaint = await prisma.complaint.findUnique({
    where: { ondcIssueId: parsed.issueId },
    select: { id: true },
  });
  if (!complaint) return { applied: false, reason: "unknown issue" };

  const sentTo = await prisma.complaintMessage.findFirst({
    where: { complaintId: complaint.id, direction: "outbound", action: "issue", status: "acked" },
    orderBy: { createdAt: "asc" },
    select: { payload: true },
  });
  const bppId = sentTo ? (JSON.parse(sentTo.payload) as { context?: { bpp_id?: string } }).context?.bpp_id : undefined;
  if (!bppId || bppId !== input.senderId) return { applied: false, reason: "issue was not sent to this seller app" };

  const messageId = ((input.body.context ?? {}) as { message_id?: string }).message_id;
  const scopedMessageId = messageId ? scoped(input.senderId, messageId) : undefined;
  const known = scopedMessageId
    ? await prisma.complaintMessage.findUnique({ where: { messageId: scopedMessageId }, select: { id: true } })
    : null;
  if (!known) {
    await prisma.complaintMessage.create({
      data: {
        complaintId: complaint.id,
        direction: "inbound",
        action: "on_issue",
        messageId: scopedMessageId,
        payload: input.raw,
        status: "acked",
        receivedAt: new Date(),
      },
    });
  }

  for (const r of parsed.resolutions) {
    await prisma.complaintResolution.upsert({
      where: { resolutionId: scoped(complaint.id, r.id) },
      create: {
        complaintId: complaint.id,
        resolutionId: scoped(complaint.id, r.id),
        itemId: r.itemId,
        type: r.type,
        amountPaise: r.amountPaise,
        description: r.description,
      },
      update: {},
    });
  }

  for (const a of parsed.sellerActions) {
    const code = SELLER_ACTION[a.code];
    if (!code) continue;
    const { deduped } = await recordAction({
      complaintId: complaint.id,
      code,
      ...(a.shortDesc ? { description: customerSentence(code, a.shortDesc) } : {}),
      actionBy: "SELLER-NP",
      actorId: input.senderId,
      actionId: scoped(complaint.id, a.id),
    });
    if (!deduped && code === "INFO_REQUESTED") {
      await prisma.complaint.update({
        where: { id: complaint.id },
        data: { infoRequestedAt: new Date(), infoRequest: a.shortDesc.slice(0, 500) || "The seller asked for more information" },
      });
    }
  }
  return { applied: true };
}

/** The seller's words, framed for the customer's timeline. Raw protocol text never stands alone there. */
function customerSentence(code: ActionCode, shortDesc: string): string {
  const said = shortDesc.slice(0, 200);
  switch (code) {
    case "INFO_REQUESTED":
      return `Seller asked: ${said}`;
    case "RESOLUTION_PROPOSED":
      return "Seller proposed a resolution";
    default:
      return `Seller update: ${said}`;
  }
}
