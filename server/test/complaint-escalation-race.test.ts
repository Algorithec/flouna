import { describe, expect, it } from "vitest";
import request from "supertest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// A complaint escalates one level per request, even when two arrive together.
//
// Escalating read the current level, wrote an escalation one above it, then
// raised the level. Two taps at the same moment both read level 0, so the
// complaint went to the grievance officer twice: two escalation records and
// two entries in the timeline the customer and the officer both read.

async function raise(agent: ReturnType<typeof request.agent>) {
  const res = await agent
    .post("/api/complaints")
    .send({
      category: "ITEM",
      subCategory: "WRONG_ITEM_DELIVERED",
      description: "Received a different dish from the one I ordered",
    })
    .expect(201);
  return res.body.complaint as { id: string };
}

describe("escalating a complaint twice at once", () => {
  it("escalates it once", async () => {
    const { agent } = await authedAgent();
    const complaint = await raise(agent);

    const results = await Promise.all([
      agent.post(`/api/complaints/${complaint.id}/escalate`).send({ reason: "No response for three days" }),
      agent.post(`/api/complaints/${complaint.id}/escalate`).send({ reason: "No response for three days" }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.complaintEscalation.count({ where: { complaintId: complaint.id } })).toBe(1);
    const after = await prisma.complaint.findUniqueOrThrow({ where: { id: complaint.id } });
    expect(after.escalationLevel).toBe(1);
  });
});
