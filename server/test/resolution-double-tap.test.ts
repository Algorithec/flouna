import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Deciding a complaint's proposed resolution, twice at once.
//
// The decision was checked ("not yet decided") and then written as two
// separate steps. A double tap on Accept passed the check twice, and each
// accepted refund opens a refund record, so one ₹250 resolution became two
// refunds of ₹250. Accept and Reject pressed together were both recorded. The
// decision is now taken by a write that only one request can win.

async function complaintWithOffer() {
  const { agent, email } = await authedAgent();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const complaint = await prisma.complaint.create({
    data: {
      code: `CMP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      userId: user.id,
      category: "ITEM",
      description: "Biryani arrived cold",
    },
  });
  const resolution = await prisma.complaintResolution.create({
    data: {
      complaintId: complaint.id,
      resolutionId: `RES-${complaint.id}`,
      type: "PARTIAL_REFUND",
      amountPaise: 25000,
      description: "Refund ₹250 for the cold biryani",
    },
  });
  return { agent, complaint, resolution };
}

describe("deciding a resolution twice at once", () => {
  it("opens one refund for a double tap on accept", async () => {
    const { agent, complaint, resolution } = await complaintWithOffer();
    const path = `/api/complaints/${complaint.id}/resolution/${resolution.id}/accept`;
    const results = await Promise.all([agent.post(path).send({}), agent.post(path).send({})]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const refunds = await prisma.complaintRefund.findMany({ where: { complaintId: complaint.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountPaise).toBe(25000);
  });

  it("records only one of accept and reject", async () => {
    const { agent, complaint, resolution } = await complaintWithOffer();
    const base = `/api/complaints/${complaint.id}/resolution/${resolution.id}`;
    const [a, r] = await Promise.all([agent.post(`${base}/accept`).send({}), agent.post(`${base}/reject`).send({})]);

    expect([a.status, r.status].sort()).toEqual([200, 409]);
    const decided = await prisma.complaintResolution.findUniqueOrThrow({ where: { id: resolution.id } });
    const refunds = await prisma.complaintRefund.count({ where: { complaintId: complaint.id } });
    // Whichever won, the refund records agree with it.
    expect(refunds).toBe(decided.customerDecision === "accepted" ? 1 : 0);
    const actions = await prisma.complaintAction.count({
      where: { complaintId: complaint.id, code: { in: ["RESOLUTION_ACCEPTED", "RESOLUTION_REJECTED"] } },
    });
    expect(actions).toBe(1);
  });
});
