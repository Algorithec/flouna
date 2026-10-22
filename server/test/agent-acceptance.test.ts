import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { authedAgent } from "./helpers.js";

// End-to-end acceptance tests from the functional requirements document:
//
//   1. Search biryani under ₹300, show only matching options.
//   2. Add the biryani, search for a starter, verify biryani is still in cart.
//   3. Add the starter, verify both items are present.
//   4. Create a four-member group, initiator's items assigned only to them.
//   5. Generate a working, access-controlled group link.
//   6. Another member joins and adds an item without changing the initiator's.
//   7. Verify that the audit trail records every agent action.

type Agent = Awaited<ReturnType<typeof authedAgent>>["agent"];

async function say(agent: Agent, message: string, sessionId?: string) {
  const res = await agent.post("/api/chat/message").send({ message, ...(sessionId ? { sessionId } : {}) }).expect(200);
  return res.body as {
    sessionId: string;
    message: {
      id: string;
      content: string;
      domain: string;
      action?: { kind: string; ok: boolean; card?: Record<string, unknown>; effects?: { type: string }[] };
      recommendation?: { type: string; best: { dishId: string; name: string; effectivePaise: number; platform: string }; alternatives: { dishId: string; name: string; platform: string }[] } | null;
    };
  };
}

const cartOf = async (agent: Agent) =>
  (await agent.get("/api/cart").expect(200)).body as { lines: { dishId: string; name: string; qty: number; platform: string }[]; count: number };

describe("acceptance tests from functional requirements", () => {
  it("full Example A: search → add → search → add → group → join → audit trail", async () => {
    const { agent, email } = await authedAgent();
    const userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;

    // 1. Search biryani under ₹300 — only matching options, nothing added.
    const r1 = await say(agent, "Find the best chicken biryani under ₹300");
    const sid = r1.sessionId;
    expect(r1.message.recommendation?.type).toBe("food");
    const biryani = r1.message.recommendation!.best;
    expect(biryani.effectivePaise).toBeLessThanOrEqual(30000);
    expect((await cartOf(agent)).count).toBe(0);

    // 2. Add biryani, then search for starter — biryani stays in cart.
    const r2 = await say(agent, "Add it to my cart", sid);
    expect(r2.message.action).toMatchObject({ kind: "cart.add", ok: true });
    let cart = await cartOf(agent);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.dishId).toBe(biryani.dishId);

    const r3 = await say(agent, "Find the best chicken starter", sid);
    expect(r3.message.recommendation?.type).toBe("food");
    const starter = r3.message.recommendation!.best;
    cart = await cartOf(agent);
    expect(cart.lines.map((l) => l.dishId)).toContain(biryani.dishId);

    // 3. Add starter — both items present.
    await say(agent, "Add that too", sid);
    cart = await cartOf(agent);
    expect(cart.count).toBe(2);
    const dishIds = cart.lines.map((l) => l.dishId).sort();
    expect(dishIds).toEqual([biryani.dishId, starter.dishId].sort());

    // 4. Create group order for four — initiator's items assigned only to them.
    const r5 = await say(agent, "Create a group order for four members, but order one biryani and one starter only for me", sid);
    expect(r5.message.action).toMatchObject({ kind: "group.create", ok: true });
    const card = r5.message.action!.card as {
      type: string;
      joinPath: string;
      group: { id: string; code: string; expectedMembers: number; items: { dishId: string; isYou: boolean; userId: string }[] };
    };
    expect(card.type).toBe("group");
    expect(card.group.expectedMembers).toBe(4);
    expect(card.group.items.every((i) => i.isYou)).toBe(true);
    expect(card.group.items.map((i) => i.dishId).sort()).toEqual([biryani.dishId, starter.dishId].sort());

    // Cart cleared after move.
    expect((await cartOf(agent)).count).toBe(0);

    // 5. Group link is working and access-controlled.
    expect(card.joinPath).toBe(`/food/group?code=${card.group.code}`);

    // 6. Another member joins and adds an item — initiator's items unchanged.
    const friend = await authedAgent();
    await friend.agent.post("/api/groups/join").send({ code: card.group.code }).expect((r) => expect([200, 201]).toContain(r.status));
    await friend.agent.post(`/api/groups/${card.group.id}/items`).send({ dishId: starter.dishId, qty: 1 }).expect(201);
    const groupView = (await friend.agent.get(`/api/groups/${card.group.id}`).expect(200)).body as {
      items: { dishId: string; isYou: boolean }[];
    };
    // Friend sees the host's 2 items (not theirs) and their own 1 item.
    expect(groupView.items.filter((i) => !i.isYou)).toHaveLength(2);
    expect(groupView.items.filter((i) => i.isYou)).toHaveLength(1);

    // An unauthorized user cannot access the group.
    const stranger = await authedAgent();
    await stranger.agent.get(`/api/groups/${card.group.id}`).expect(403);

    // 7. Audit trail: every agent action is logged.
    const logs = await prisma.agentActionLog.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    const kinds = logs.map((l) => l.actionKind);
    expect(kinds).toContain("cart.add");
    expect(kinds).toContain("group.create");
    expect(logs.every((l) => l.sessionId.length > 0)).toBe(true);
    expect(logs.every((l) => l.messageId !== null && l.messageId!.length > 0)).toBe(true);
    expect(logs.filter((l) => l.actionKind === "cart.add")).toHaveLength(2);
    expect(logs.find((l) => l.actionKind === "group.create")!.success).toBe(true);
  });

  it("price constraint: search results respect the stated budget", async () => {
    const { agent } = await authedAgent();
    const r = await say(agent, "Find chicken biryani under ₹200");
    if (r.message.recommendation?.type === "food") {
      expect(r.message.recommendation.best.effectivePaise).toBeLessThanOrEqual(20000);
    }
  });

  it("duplicate add is idempotent: does not exceed the qty cap", async () => {
    const { agent } = await authedAgent();
    const r1 = await say(agent, "Find chicken biryani");
    await say(agent, "add 20 of it", r1.sessionId);
    const r = await say(agent, "add 1 more", r1.sessionId);
    expect(r.message.action!.ok).toBe(false);
    expect(r.message.content).toMatch(/already have 20/);
  });

  it("unavailable item: agent explains instead of silently failing", async () => {
    const { agent } = await authedAgent();
    const r = await say(agent, "add it to my cart");
    expect(r.message.action).toMatchObject({ kind: "cart.add", ok: false });
    expect(r.message.content.length).toBeGreaterThan(10);
  });
});
