import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { appendIssueAction, buildIssue, parseOnIssue, ISSUE_SUBCATEGORY, type IssueInput } from "../src/modules/ondc/igm.js";

// IGM 2.0.0. Incoming messages are the Pramaan mock seller's own on_issue
// messages from a certified buyer flow published by ONDC (v1.2.0-logs), with
// the buyer's personal details replaced. Outgoing ones were checked once
// against ONDC's IGM 2.0.0 JSON schema; the rules its validator applies on top
// of the schema are pinned here.

const pramaan = JSON.parse(readFileSync(new URL("./fixtures/ondc-igm2-pramaan-on_issue.json", import.meta.url), "utf8")) as Record<
  string,
  unknown
>;

const at = new Date("2026-10-16T10:00:00Z");
const later = new Date("2026-10-16T11:00:00Z");
const input: IssueInput = {
  ref: {
    domain: "ONDC:RET11",
    city: "std:080",
    transactionId: "t1",
    bpp: { id: "seller.test", uri: "https://seller.test/ondc" },
    orderId: "O1",
    providerId: "P1",
    fulfillmentId: "F1",
    items: [{ id: "I1", count: 2 }],
  },
  issueId: "issue-1",
  status: "OPEN",
  createdAt: at,
  reason: "WRONG_ITEM_DELIVERED",
  description: "Got paneer instead of chicken",
  consumer: { id: "C1", name: "Test Customer", phone: "+91 90000 00001", email: "c@example.com" },
  interfacing: { name: "Flouna Support", phone: "7396144250", email: "info@algorithec.com" },
  actions: [{ id: "A1", code: "OPEN", shortDesc: "Complaint created", by: "C1", byName: "Test Customer", at }],
  now: at,
};

describe("IGM 2.0 issue we send", () => {
  it("follows the validator's rules for a newly opened issue", () => {
    const { context, message } = buildIssue(input);
    const issue = message.issue;
    expect(context).toMatchObject({ action: "issue", bap_id: "ondc.flouna.com", bpp_id: "seller.test", ttl: "PT30S", core_version: "1.2.0" });
    expect(issue.updated_at).toBe(issue.created_at);
    expect(new Date(issue.updated_at) <= new Date(context.timestamp)).toBe(true);
    expect(issue.last_action_id).toBe("A1");
    expect(issue.source_id).toBe("C1");
    expect(issue.complainant_id).toBe("ondc.flouna.com");
    expect(issue.actors.map((a) => a.info.org.name)).toEqual(["ondc.flouna.com::ONDC:RET11", "ondc.flouna.com::ONDC:RET11"]);
    expect(issue.descriptor).toMatchObject({ code: "ITM03", short_desc: "Item mismatch" });
    expect(issue.refs.map((r) => r.ref_type)).toEqual(["ORDER", "PROVIDER", "FULFILLMENT", "ITEM"]);
    expect(issue.refs[3]!.tags![0]!.list[0]).toEqual({ descriptor: { code: "quantity.selected.count" }, value: "2" });
    expect("update_target" in message).toBe(false);
  });

  it("sends phones as ten digits, which is what the validator reads", () => {
    const issue = buildIssue(input).message.issue;
    expect(issue.actors[0]!.info.contact.phone).toBe("9000000001");
    expect(() => buildIssue({ ...input, consumer: { ...input.consumer, phone: "12345" } })).toThrow(/phone/);
  });

  it("re-sends the whole issue with the new action appended and marked as such", () => {
    const { context, message } = buildIssue({
      ...input,
      actions: [
        ...input.actions,
        { id: "A2", code: "RESOLUTION_ACCEPTED", shortDesc: "Resolution accepted", by: "C1", byName: "Test Customer", at: later, refId: "R1", refType: "RESOLUTIONS" },
      ],
      resolutions: [{ id: "R1", descriptor: { code: "REFUND", short_desc: "Refund" } }],
      now: later,
    });
    expect(message.update_target).toEqual([{ path: "issue.actions", action: "APPENDED" }]);
    expect(message.issue.last_action_id).toBe("A2");
    expect(message.issue.updated_at).toBe(later.toISOString());
    expect(context.timestamp).toBe(later.toISOString());
    expect(message.issue.actions[1]).toMatchObject({ ref_id: "R1", ref_type: "RESOLUTIONS", descriptor: { code: "RESOLUTION_ACCEPTED" } });
    expect(message.issue.resolutions).toHaveLength(1);
  });

  it("uses the mobility context for a ride", () => {
    const { context } = buildIssue({ ...input, ref: { ...input.ref, domain: "ONDC:TRV10" }, reason: "DRIVER_CONDUCT" });
    expect(context).toMatchObject({ version: "2.0.1", location: { city: { code: "std:080" } } });
    expect("core_version" in context).toBe(false);
  });

  it("refuses a reason with no ONDC category rather than sending the wrong one", () => {
    for (const reason of ["OTHER", "PAYMENT_ISSUE", "made-up"]) {
      expect(ISSUE_SUBCATEGORY[reason]).toBeUndefined();
      expect(() => buildIssue({ ...input, reason })).toThrow(/no ONDC issue category/);
    }
  });

  it("refuses an issue with no actions or a bad item count", () => {
    expect(() => buildIssue({ ...input, actions: [] })).toThrow();
    expect(() => buildIssue({ ...input, ref: { ...input.ref, items: [{ id: "I1", count: 0 }] } })).toThrow();
  });
});

describe("IGM 2.0 on_issue a seller sends", () => {
  it("reads the seller's acknowledgement and leaves our own echoed actions out", () => {
    const p = parseOnIssue(pramaan.on_issue_processing_1)!;
    expect(p.issueId).toBe("3e3c0a57-1fc3-4d99-828c-268bc3819643");
    expect(p.sellerActions.length).toBeGreaterThan(0);
    expect(p.sellerActions.every((a) => a.by === "NP2")).toBe(true);
    expect(p.sellerActions.map((a) => a.code)).toContain("PROCESSING");
  });

  it("reads a request for more information with what was asked", () => {
    const p = parseOnIssue(pramaan.on_issue_info_required)!;
    const info = p.sellerActions.find((a) => a.code === "INFO_REQUESTED")!;
    expect(info.shortDesc).toBe("Provide product image");
  });

  it("reads proposed resolutions as options, with refund amounts in paise", () => {
    const p = parseOnIssue(pramaan.on_issue_resolution_proposed)!;
    expect(p.resolutions).toEqual([
      { id: "R1", type: "REFUND", description: "Providing refund for the item", itemId: "I1", amountPaise: 20000 },
      { id: "R2", type: "REPLACEMENT", description: "Providing replacement of the item", itemId: "I1" },
    ]);
    expect(p.sellerActions.at(-1)).toMatchObject({ code: "RESOLUTION_PROPOSED", refId: "R_PARENT" });
  });

  it("reads the seller resolving it", () => {
    const p = parseOnIssue(pramaan.on_issue_resolved)!;
    expect(p.sellerActions.at(-1)).toMatchObject({ code: "RESOLVED", refId: "R2" });
    expect(p.status).toBe("RESOLVED");
  });

  it("reads the current descriptor form as well as the older description form", () => {
    const old = pramaan.on_issue_info_required as { message: { issue: { actions: Record<string, unknown>[] } } };
    const current = structuredClone(old);
    for (const a of current.message.issue.actions) {
      a.descriptor = a.description;
      delete a.description;
    }
    expect(parseOnIssue(current)!.sellerActions).toEqual(parseOnIssue(old)!.sellerActions);
  });

  it("skips action codes it does not know instead of guessing", () => {
    const msg = structuredClone(pramaan.on_issue_info_required) as { message: { issue: { actions: Record<string, unknown>[] } } };
    msg.message.issue.actions.push({ id: "AX", action_by: "NP2", updated_at: later.toISOString(), descriptor: { code: "SOMETHING_NEW" } });
    expect(parseOnIssue(msg)!.sellerActions.map((a) => a.id)).not.toContain("AX");
  });

  it("returns nothing for a message that is not an issue", () => {
    expect(parseOnIssue({})).toBeNull();
    expect(parseOnIssue({ message: { issue: { id: "x", actions: [] } } })).toBeNull();
  });

  it("ignores a refund amount that is not an amount", () => {
    const msg = structuredClone(pramaan.on_issue_resolution_proposed) as {
      message: { issue: { resolutions: { tags?: { list: { value: string }[] }[] }[] } };
    };
    msg.message.issue.resolutions[1]!.tags![0]!.list[1]!.value = "two hundred";
    expect(parseOnIssue(msg)!.resolutions[0]!.amountPaise).toBeUndefined();
  });
});

describe("IGM 2.0 customer actions re-sent to the seller", () => {
  const first = buildIssue(input);
  const latest = (pramaan.on_issue_resolution_proposed as { message: { issue: Record<string, unknown> } }).message.issue;

  it("appends the customer's acceptance to the seller's latest copy, keeping its resolutions", () => {
    const m = appendIssueAction({
      firstContext: first.context,
      latestIssue: latest,
      action: { id: "B1", code: "RESOLUTION_ACCEPTED", shortDesc: "Resolution accepted", by: "C1", byName: "Test Customer", at: later, refId: "R2", refType: "RESOLUTIONS" },
      now: later,
    });
    const actions = m.message.issue.actions as Record<string, unknown>[];
    expect(m.context).toMatchObject({ action: "issue", bpp_id: "seller.test", timestamp: later.toISOString() });
    expect(m.context.message_id).not.toBe(first.context.message_id);
    expect(actions).toHaveLength((latest.actions as unknown[]).length + 1);
    expect(actions.at(-1)).toMatchObject({ id: "B1", ref_id: "R2", descriptor: { code: "RESOLUTION_ACCEPTED" } });
    expect(m.message.issue.last_action_id).toBe("B1");
    expect(m.message.issue.resolutions).toEqual(latest.resolutions);
    expect(m.message.issue.status).toBe(latest.status);
    expect(m.message.update_target).toEqual([{ path: "issue.actions", action: "APPENDED" }]);
  });

  it("closing sets the issue closed", () => {
    const m = appendIssueAction({
      firstContext: first.context,
      latestIssue: latest,
      action: { id: "B2", code: "CLOSED", shortDesc: "Closing the complaint", by: "C1", byName: "Test Customer", at: later, tags: [{ descriptor: { code: "CLOSURE_DETAILS" }, list: [{ descriptor: { code: "RATING" }, value: "THUMBS-UP" }] }] },
      now: later,
    });
    expect(m.message.issue.status).toBe("CLOSED");
  });

  it("will not add the same action twice or add to nothing", () => {
    const action = { id: "A1", code: "INFO_PROVIDED" as const, shortDesc: "x", by: "C1", byName: "T", at: later };
    expect(() => appendIssueAction({ firstContext: first.context, latestIssue: latest, action })).toThrow(/already/);
    expect(() => appendIssueAction({ firstContext: first.context, latestIssue: {}, action: { ...action, id: "Z" } })).toThrow(/no issue/);
  });
});
