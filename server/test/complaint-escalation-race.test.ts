import { describe, expect, it } from "vitest";
import request from "supertest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Escalating a complaint with a double tap.
//
// Two taps at once both read level 0 and both escalated, which the level
// claim fixed. CI then found the slower case: the second tap arriving after
// the first had finished read level 1 and escalated again, so one double tap
// sent the complaint past the grievance officer straight to ONDC. The app now
// says which level the customer saw when they tapped, and the server only
// escalates from that level, so a repeat of the same tap is refused however
// late it arrives.

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

const tap = (agent: ReturnType<typeof request.agent>, id: string, fromLevel: number) =>
  agent.post(`/api/complaints/${id}/escalate`).send({ reason: "No response for three days", fromLevel });

async function levelOf(id: string) {
  return {
    level: (await prisma.complaint.findUniqueOrThrow({ where: { id } })).escalationLevel,
    records: await prisma.complaintEscalation.count({ where: { complaintId: id } }),
  };
}

describe("escalating a complaint with a double tap", () => {
  it("escalates once when both taps arrive together", async () => {
    const { agent } = await authedAgent();
    const complaint = await raise(agent);
    const results = await Promise.all([tap(agent, complaint.id, 0), tap(agent, complaint.id, 0)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await levelOf(complaint.id)).toEqual({ level: 1, records: 1 });
  });

  it("escalates once when the second tap arrives after the first finished", async () => {
    const { agent } = await authedAgent();
    const complaint = await raise(agent);
    expect((await tap(agent, complaint.id, 0)).status).toBe(200);
    expect((await tap(agent, complaint.id, 0)).status).toBe(409);
    expect(await levelOf(complaint.id)).toEqual({ level: 1, records: 1 });
  });

  it("still lets the customer escalate on to ONDC from the level they see", async () => {
    const { agent } = await authedAgent();
    const complaint = await raise(agent);
    await tap(agent, complaint.id, 0).expect(200);
    const res = await tap(agent, complaint.id, 1).expect(200);
    expect(res.body.level).toBe(2);
    expect(await levelOf(complaint.id)).toEqual({ level: 2, records: 2 });
  });
});
