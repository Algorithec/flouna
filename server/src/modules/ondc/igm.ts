import crypto from "node:crypto";
import { BAP_ID, BAP_URI, type OndcDomain } from "./context.js";

// Complaints over ONDC (IGM 2.0.0): the issue we send and the on_issue a
// seller app answers with.
//
// Built to ONDC's own validator for IGM 2.0.0 (log-validation-utility,
// schema/Igm/2.0.0 and utils/igm/igm2, as of its May 2025 contract update),
// and checked against the Pramaan mock seller's messages in a published
// certified buyer flow. Two things differ from older IGM and from much of
// what is in the wild:
//
//   - There is no issue_status in 2.0. Each side re-sends the whole issue with
//     its new action appended, as issue (us) or on_issue (the seller).
//   - Actions and the issue carry a `descriptor`. Earlier builds of the
//     validator wanted `description`, and sellers on those builds still send
//     it, so incoming messages are read either way. Outgoing ones use the
//     current form.
//
// Nothing here touches the database. The adapter in complaints/ maps between
// this and the complaint model.

/** Action codes, exactly as the 2.0.0 schema enumerates them. */
export const IGM_ACTION_CODES = [
  "OPEN",
  "PROCESSING",
  "RESOLVED",
  "CLOSED",
  "INFO_REQUESTED",
  "INFO_PROVIDED",
  "INFO_NOT_AVAILABLE",
  "RESOLUTION_PROPOSED",
  "RESOLUTION_ACCEPTED",
  "RESOLUTION_REJECTED",
  "RESOLUTION_CASCADED",
  "ESCALATED",
] as const;
export type IgmActionCode = (typeof IGM_ACTION_CODES)[number];

export const IGM_ISSUE_STATUSES = ["OPEN", "PROCESSING", "RESOLVED", "CLOSED"] as const;
export type IgmIssueStatus = (typeof IGM_ISSUE_STATUSES)[number];

/**
 * The fulfilment ref type. The 2.0.0 schema's enum spells it FULFILLMENT while
 * the same validator's flow check demands FULFILMENT, so one of the two will
 * complain whichever is sent. Kept in one place so it is a one line change
 * once ONDC settles it (raise it in Workbench before certification).
 */
export const FULFILLMENT_REF_TYPE = "FULFILLMENT";

/**
 * Our complaint reasons, mapped to ONDC's issue sub-category codes (the list
 * in log-validation-utility utils/issue_subcategories.ts, labelled as in
 * ONDC's reference buyer apps). A reason without a clear match is left out
 * rather than forced into a code that says something else; such complaints
 * are handled by us and not sent to the seller.
 */
export const ISSUE_SUBCATEGORY: Record<string, { code: string; label: string }> = {
  ORDER_NOT_RECEIVED: { code: "ORD01", label: "Order not received" },
  WRONG_ITEM_DELIVERED: { code: "ITM03", label: "Item mismatch" },
  ITEM_DAMAGED: { code: "ITM04", label: "Quality issue" },
  REFUND_NOT_RECEIVED: { code: "PMT01", label: "Refund not received" },
  DRIVER_CONDUCT: { code: "AGT01", label: "Agent behavioral issue" },
};

/** What the network knows about the order a complaint is about. */
export type IgmOrderRef = {
  domain: OndcDomain;
  city: string;
  transactionId: string;
  bpp: { id: string; uri: string };
  orderId: string;
  providerId: string;
  fulfillmentId: string;
  items: { id: string; count: number }[];
};

export type IgmPerson = { id: string; name: string; phone: string; email: string };

/** One entry in the issue's action history, ours or the seller's. */
export type IgmAction = {
  id: string;
  code: IgmActionCode;
  shortDesc: string;
  by: string;
  byName: string;
  at: Date;
  refId?: string;
  refType?: string;
  images?: string[];
  tags?: unknown[];
};

export type IssueInput = {
  ref: IgmOrderRef;
  issueId: string;
  status: IgmIssueStatus;
  createdAt: Date;
  /** The complaint reason, one of ISSUE_SUBCATEGORY's keys. */
  reason: string;
  description: string;
  images?: string[];
  consumer: IgmPerson;
  /** Flouna, as the interfacing app. */
  interfacing: Omit<IgmPerson, "id">;
  actions: IgmAction[];
  /** The seller's resolutions, echoed back when we accept one. */
  resolutions?: unknown[];
  expectedResponse?: string;
  expectedResolution?: string;
  messageId?: string;
  now?: Date;
};

/** A phone as the validator reads it: ten digits, no country code. */
function tenDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) throw new Error(`IGM contact phone must be a 10 digit Indian number, got ${phone}`);
  return digits;
}

function igmContext(ref: IgmOrderRef, messageId: string, at: Date) {
  const base = {
    domain: ref.domain,
    action: "issue",
    bap_id: BAP_ID,
    bap_uri: BAP_URI,
    bpp_id: ref.bpp.id,
    bpp_uri: ref.bpp.uri,
    transaction_id: ref.transactionId,
    message_id: messageId,
    timestamp: at.toISOString(),
    ttl: "PT30S",
    location: { country: { code: "IND" }, city: { code: ref.city } },
  };
  // The 2.0.0 schema asks retail for core_version and city, and mobility for
  // version and location, both alongside location.
  return ref.domain === "ONDC:TRV10"
    ? { ...base, version: "2.0.1" }
    : { ...base, core_version: "1.2.0", city: ref.city };
}

/**
 * The issue message, as first raised or re-sent with a new action appended.
 * The whole issue goes every time: IGM 2.0 has no partial update.
 */
export function buildIssue(i: IssueInput) {
  const sub = ISSUE_SUBCATEGORY[i.reason];
  if (!sub) throw new Error(`Complaint reason ${i.reason} has no ONDC issue category, so it is not sent to the seller`);
  if (i.actions.length === 0) throw new Error("An issue needs at least the action that opened it");
  for (const it of i.ref.items) {
    if (!Number.isSafeInteger(it.count) || it.count < 1) throw new Error(`Item ${it.id} has a count of ${it.count}`);
  }
  const last = i.actions[i.actions.length - 1]!;
  const now = i.now ?? new Date();
  // The validator wants updated_at no later than the message timestamp and no
  // earlier than the last action, so the message is stamped after both.
  const updatedAt = last.at;
  const stamp = now > updatedAt ? now : updatedAt;
  const org = `${BAP_ID}::${i.ref.domain}`;
  const consumer = { ...i.consumer, phone: tenDigits(i.consumer.phone) };
  const interfacingPhone = tenDigits(i.interfacing.phone);

  return {
    context: igmContext(i.ref, i.messageId ?? crypto.randomUUID(), stamp),
    message: {
      ...(i.actions.length > 1 ? { update_target: [{ path: "issue.actions", action: "APPENDED" }] } : {}),
      issue: {
        id: i.issueId,
        status: i.status,
        level: "ISSUE",
        created_at: i.createdAt.toISOString(),
        updated_at: updatedAt.toISOString(),
        expected_response_time: { duration: i.expectedResponse ?? "PT2H" },
        expected_resolution_time: { duration: i.expectedResolution ?? "P1D" },
        refs: [
          { ref_id: i.ref.orderId, ref_type: "ORDER" },
          { ref_id: i.ref.providerId, ref_type: "PROVIDER" },
          { ref_id: i.ref.fulfillmentId, ref_type: FULFILLMENT_REF_TYPE },
          ...i.ref.items.map((it) => ({
            ref_id: it.id,
            ref_type: "ITEM",
            tags: [
              {
                descriptor: { code: "message.order.items" },
                list: [{ descriptor: { code: "quantity.selected.count" }, value: String(it.count) }],
              },
            ],
          })),
        ],
        actors: [
          {
            id: consumer.id,
            type: "CONSUMER",
            info: {
              org: { name: org },
              person: { name: consumer.name },
              contact: { phone: consumer.phone, email: consumer.email },
            },
          },
          {
            id: BAP_ID,
            type: "INTERFACING_NP",
            info: {
              org: { name: org },
              person: { name: i.interfacing.name },
              contact: { phone: interfacingPhone, email: i.interfacing.email },
            },
          },
        ],
        // The validator's rules for an opened issue: the complaint comes from
        // the consumer and is lodged by the interfacing app.
        source_id: consumer.id,
        complainant_id: BAP_ID,
        respondent_ids: [i.ref.bpp.id],
        descriptor: {
          code: sub.code,
          short_desc: sub.label,
          long_desc: i.description,
          ...(i.images?.length ? { images: i.images.map((url) => ({ url })) } : {}),
        },
        last_action_id: last.id,
        actions: i.actions.map((a) => ({
          id: a.id,
          ...(a.refId ? { ref_id: a.refId, ref_type: a.refType ?? "ACTION" } : {}),
          descriptor: { code: a.code, short_desc: a.shortDesc, ...(a.images?.length ? { images: a.images } : {}) },
          updated_at: a.at.toISOString(),
          action_by: a.by,
          actor_details: { name: a.byName },
          ...(a.tags ? { tags: a.tags } : {}),
        })),
        ...(i.resolutions ? { resolutions: i.resolutions } : {}),
      },
    },
  };
}

/** A seller's resolution option, as the customer will be offered it. */
export type IgmResolution = {
  id: string;
  /** REFUND, REPLACEMENT, CANCEL, NO_ACTION and so on, as the seller sent it. */
  type: string;
  description: string;
  itemId?: string;
  /** Refund amount in paise, when the seller states one. */
  amountPaise?: number;
};

export type ParsedOnIssue = {
  issueId: string;
  status: string;
  lastActionId?: string;
  /** Actions taken by the seller side, oldest first. Ours, echoed back, are left out. */
  sellerActions: IgmAction[];
  /** Options to choose between. The PARENT entry that groups them is not one. */
  resolutions: IgmResolution[];
};

type Wire = Record<string, unknown>;
const asObj = (v: unknown): Wire => (v && typeof v === "object" ? (v as Wire) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Rupee string to paise, or undefined if it is not an amount. */
function paiseOf(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d+(\.\d{1,2})?$/.test(v.trim())) return undefined;
  return Math.round(Number(v) * 100);
}

/**
 * Reads an on_issue. Returns null if it is not one we can act on: no issue
 * id, or no actions. Unknown action codes are skipped, not guessed at.
 */
export function parseOnIssue(body: unknown): ParsedOnIssue | null {
  const issue = asObj(asObj(asObj(body).message).issue);
  const issueId = str(issue.id);
  const rawActions = asArr(issue.actions);
  if (!issueId || rawActions.length === 0) return null;

  // Who is on our side, so our own actions echoed back are not re-applied.
  const ours = new Set<string>([BAP_ID]);
  for (const a of asArr(issue.actors)) {
    const actor = asObj(a);
    if ((actor.type === "CONSUMER" || actor.type === "INTERFACING_NP") && str(actor.id)) ours.add(actor.id as string);
  }

  const sellerActions: IgmAction[] = [];
  for (const a of rawActions) {
    const action = asObj(a);
    const d = asObj(action.descriptor ?? action.description);
    const code = str(d.code);
    const id = str(action.id);
    const by = str(action.action_by);
    if (!code || !id || !by || ours.has(by)) continue;
    if (!(IGM_ACTION_CODES as readonly string[]).includes(code)) continue;
    const at = new Date(str(action.updated_at) ?? "");
    sellerActions.push({
      id,
      code: code as IgmActionCode,
      shortDesc: str(d.short_desc) ?? str(d.name) ?? "",
      by,
      byName: str(asObj(action.actor_details).name) ?? "",
      at: Number.isNaN(at.getTime()) ? new Date(0) : at,
      ...(str(action.ref_id) ? { refId: action.ref_id as string } : {}),
      ...(str(action.ref_type) ? { refType: action.ref_type as string } : {}),
    });
  }

  const resolutions: IgmResolution[] = [];
  for (const r of asArr(issue.resolutions)) {
    const res = asObj(r);
    const d = asObj(res.descriptor ?? res.description);
    const id = str(res.id);
    const type = str(d.code);
    if (!id || !type || type === "PARENT") continue;
    let itemId: string | undefined;
    let amountPaise: number | undefined;
    for (const t of asArr(res.tags)) {
      for (const entry of asArr(asObj(t).list)) {
        const e = asObj(entry);
        const k = str(asObj(e.descriptor).code);
        if (k === "ITEM") itemId = str(e.value);
        if (k === "REFUND_AMOUNT") amountPaise = paiseOf(e.value);
      }
    }
    resolutions.push({
      id,
      type,
      description: str(d.short_desc) ?? str(d.long_desc) ?? type,
      ...(itemId ? { itemId } : {}),
      ...(amountPaise !== undefined ? { amountPaise } : {}),
    });
  }

  return { issueId, status: str(issue.status) ?? "", lastActionId: str(issue.last_action_id), sellerActions, resolutions };
}

/**
 * The issue re-sent with one of the customer's actions appended: replying to
 * a request for information, accepting or rejecting a resolution, escalating,
 * or closing.
 *
 * Built on the seller's latest copy of the issue (its last on_issue), so the
 * seller's own actions and resolutions go back exactly as it sent them, and on
 * our first issue's context, which carries our side of the conversation.
 */
export function appendIssueAction(o: {
  firstContext: Record<string, unknown>;
  latestIssue: Record<string, unknown>;
  action: IgmAction;
  messageId?: string;
  now?: Date;
}) {
  const actions = asArr(o.latestIssue.actions);
  if (!str(o.latestIssue.id) || actions.length === 0) throw new Error("There is no issue to add to");
  if (actions.some((a) => asObj(a).id === o.action.id)) throw new Error(`Action ${o.action.id} is already on the issue`);
  const now = o.now ?? new Date();
  const at = o.action.at > now ? now : o.action.at;
  const appended = {
    id: o.action.id,
    ...(o.action.refId ? { ref_id: o.action.refId, ref_type: o.action.refType ?? "ACTION" } : {}),
    descriptor: {
      code: o.action.code,
      short_desc: o.action.shortDesc,
      ...(o.action.images?.length ? { images: o.action.images } : {}),
    },
    updated_at: at.toISOString(),
    action_by: o.action.by,
    actor_details: { name: o.action.byName },
    ...(o.action.tags ? { tags: o.action.tags } : {}),
  };
  return {
    context: {
      ...o.firstContext,
      action: "issue",
      message_id: o.messageId ?? crypto.randomUUID(),
      timestamp: now.toISOString(),
      ttl: "PT30S",
    },
    message: {
      update_target: [{ path: "issue.actions", action: "APPENDED" }],
      issue: {
        ...o.latestIssue,
        // Closing is the one status the customer's side sets; everything else
        // stays where the seller put it.
        ...(o.action.code === "CLOSED" ? { status: "CLOSED" } : {}),
        updated_at: at.toISOString(),
        last_action_id: o.action.id,
        actions: [...actions, appended],
      },
    },
  };
}
