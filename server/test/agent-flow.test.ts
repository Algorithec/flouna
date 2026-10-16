import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { authedAgent } from "./helpers.js";

// The founder's brief (Agent Flow, Example A and its acceptance tests), run
// through the real chat endpoint against the real catalogue and database:
// chat carries out instructions across messages, remembering what it showed
// and what it did.

type Agent = Awaited<ReturnType<typeof authedAgent>>["agent"];

async function say(agent: Agent, message: string, sessionId?: string) {
  const res = await agent.post("/api/chat/message").send({ message, ...(sessionId ? { sessionId } : {}) }).expect(200);
  return res.body as {
    sessionId: string;
    message: {
      content: string;
      domain: string;
      action?: { kind: string; ok: boolean; card?: Record<string, unknown>; effects?: { type: string; value?: string; path?: string }[] };
      recommendation?: { type: string; best: { dishId: string; name: string; effectivePaise: number; platform: string }; alternatives: { dishId: string; name: string; platform: string }[] } | null;
    };
  };
}

const cartOf = async (agent: Agent) =>
  (await agent.get("/api/cart").expect(200)).body as { lines: { dishId: string; name: string; qty: number; platform: string }[]; count: number };

describe("chat carries out instructions (founder's Example A)", () => {
  it("finds, adds, finds again, adds again, then makes a group order with the host's items as the host's", async () => {
    const { agent } = await authedAgent();

    // Search for biryani under ₹300: shown, not added.
    const r1 = await say(agent, "Find the best chicken biryani under ₹300");
    const sid = r1.sessionId;
    expect(r1.message.recommendation?.type).toBe("food");
    const biryani = r1.message.recommendation!.best;
    expect(biryani.effectivePaise).toBeLessThanOrEqual(30000);
    expect((await cartOf(agent)).count).toBe(0);

    // "Add it to my cart": the biryani that was shown.
    const r2 = await say(agent, "Add it to my cart", sid);
    expect(r2.message.domain).toBe("action");
    expect(r2.message.action).toMatchObject({ kind: "cart.add", ok: true });
    expect(r2.message.action!.effects).toContainEqual({ type: "cart_changed" });
    let cart = await cartOf(agent);
    expect(cart.lines.map((l) => l.dishId)).toEqual([biryani.dishId]);

    // A new search keeps the biryani.
    const r3 = await say(agent, "Find the best chicken starter", sid);
    expect(r3.message.recommendation?.type).toBe("food");
    const starter = r3.message.recommendation!.best;
    expect((await cartOf(agent)).lines.map((l) => l.dishId)).toEqual([biryani.dishId]);

    // "Add that too": the starter, the most recent thing shown.
    await say(agent, "Add that too", sid);
    cart = await cartOf(agent);
    expect(cart.lines.map((l) => l.dishId).sort()).toEqual([biryani.dishId, starter.dishId].sort());

    // Group order for four, with the two items as the host's only.
    const r5 = await say(agent, "Create a group order for four members, but order one biryani and one starter only for me", sid);
    expect(r5.message.action).toMatchObject({ kind: "group.create" });
    expect(r5.message.action!.ok).toBe(true);
    if (biryani.platform !== starter.platform) expect(r5.message.content).toMatch(/goes through one platform/);
    const card = r5.message.action!.card as { type: string; joinPath: string; group: { id: string; code: string; expectedMembers: number; items: { dishId: string; isYou: boolean }[] } };
    expect(card.type).toBe("group");
    expect(card.joinPath).toBe(`/food/group?code=${card.group.code}`);
    expect(card.group.expectedMembers).toBe(4);
    expect(card.group.items.map((i) => i.dishId).sort()).toEqual([biryani.dishId, starter.dishId].sort());
    expect(card.group.items.every((i) => i.isYou)).toBe(true);
    // Moved, not copied, so nothing is ordered twice.
    expect((await cartOf(agent)).count).toBe(0);

    // Another member joins with the code and adds their own dish. The host's
    // items stay the host's and are not copied to them.
    const friend = await authedAgent();
    await friend.agent.post("/api/groups/join").send({ code: card.group.code }).expect((r) => expect([200, 201]).toContain(r.status));
    await friend.agent.post(`/api/groups/${card.group.id}/items`).send({ dishId: starter.dishId, qty: 1 }).expect(201);
    const after = (await friend.agent.get(`/api/groups/${card.group.id}`).expect(200)).body as { items: { dishId: string; isYou: boolean }[] };
    expect(after.items.filter((i) => !i.isYou)).toHaveLength(2);
    expect(after.items.filter((i) => i.isYou)).toHaveLength(1);

    // "Show my group" later in the same chat.
    const r6 = await say(agent, "show my group order", sid);
    expect(r6.message.action).toMatchObject({ kind: "group.show", ok: true });
  });

  it("picks by position, and says so when the position was never shown", async () => {
    const { agent } = await authedAgent();
    const r1 = await say(agent, "Find paneer");
    const second = r1.message.recommendation?.alternatives[0];
    const r2 = await say(agent, "add 2 of the second one", r1.sessionId);
    if (!second) {
      expect(r2.message.action!.ok).toBe(false);
      return;
    }
    expect((await cartOf(agent)).lines).toEqual([expect.objectContaining({ dishId: second.dishId, qty: 2 })]);
    const r3 = await say(agent, "add the sixth one", r1.sessionId);
    const shown = 1 + r1.message.recommendation!.alternatives.length;
    if (shown < 6) expect(r3.message.content).toMatch(new RegExp(`only showed ${shown}`));
  });

  it("asks before adding when nothing was shown, rather than guessing", async () => {
    const { agent } = await authedAgent();
    const r = await say(agent, "add it to my cart");
    expect(r.message.action).toMatchObject({ kind: "cart.add", ok: false });
    expect(r.message.content).toMatch(/Tell me what you'd like first/);
    expect((await cartOf(agent)).count).toBe(0);
  });

  it("asks before clearing the cart, and does nothing on no", async () => {
    const { agent } = await authedAgent();
    const r1 = await say(agent, "Find chicken biryani");
    await say(agent, "add it", r1.sessionId);
    const ask = await say(agent, "clear my cart", r1.sessionId);
    expect(ask.message.action!.card).toMatchObject({ type: "confirm" });
    expect((await cartOf(agent)).count).toBe(1);
    await say(agent, "no", r1.sessionId);
    expect((await cartOf(agent)).count).toBe(1);
    // A "yes" with nothing pending does nothing.
    const stray = await say(agent, "yes", r1.sessionId);
    expect(stray.message.action!.ok).toBe(false);
    expect((await cartOf(agent)).count).toBe(1);
    await say(agent, "clear my cart", r1.sessionId);
    await say(agent, "yes", r1.sessionId);
    expect((await cartOf(agent)).count).toBe(0);
  });

  it("drops a question once the conversation moves on", async () => {
    const { agent } = await authedAgent();
    const r1 = await say(agent, "Find chicken biryani");
    await say(agent, "add it", r1.sessionId);
    await say(agent, "clear my cart", r1.sessionId);
    await say(agent, "Find a dessert", r1.sessionId);
    await say(agent, "yes", r1.sessionId);
    expect((await cartOf(agent)).count).toBe(1);
  });

  it("drops a question when the next message is a different instruction", async () => {
    const { agent } = await authedAgent();
    const r1 = await say(agent, "Find chicken biryani");
    await say(agent, "add it", r1.sessionId);
    await say(agent, "clear my cart", r1.sessionId);
    await say(agent, "show my cart", r1.sessionId);
    await say(agent, "yes", r1.sessionId);
    expect((await cartOf(agent)).count).toBe(1);
  });

  it("says how many were really added when the 20 a dish limit cuts an add short", async () => {
    const { agent } = await authedAgent();
    const r1 = await say(agent, "Find chicken biryani");
    await say(agent, "add 18 of it", r1.sessionId);
    const r = await say(agent, "add 5 of it", r1.sessionId);
    expect(r.message.content).toMatch(/Added 2 .* You now have 20, the most one order can hold/);
    const full = await say(agent, "add another", r1.sessionId);
    expect(full.message.content).toMatch(/already have 20/);
    expect(full.message.action!.ok).toBe(false);
  });

  it("removes and changes quantities by name", async () => {
    const { agent } = await authedAgent();
    const r1 = await say(agent, "Find chicken biryani");
    const name = r1.message.recommendation!.best.name;
    await say(agent, "add it", r1.sessionId);
    await say(agent, "add another", r1.sessionId);
    expect((await cartOf(agent)).lines[0]!.qty).toBe(2);
    await say(agent, `change ${name.toLowerCase()} to 5`, r1.sessionId);
    expect((await cartOf(agent)).lines[0]!.qty).toBe(5);
    await say(agent, "change it to 3", r1.sessionId);
    expect((await cartOf(agent)).lines[0]!.qty).toBe(3);
    const r = await say(agent, "remove it", r1.sessionId);
    expect(r.message.action).toMatchObject({ kind: "cart.remove", ok: true });
    expect((await cartOf(agent)).count).toBe(0);
  });

  it("changes settings the customer could change themselves, and sends the rest to the screen", async () => {
    const { agent, email } = await authedAgent();
    await say(agent, "turn off email updates");
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).emailUpdates).toBe(false);
    await say(agent, "set my weekly budget to 2000");
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).weeklyFoodBudgetPaise).toBe(200000);
    await say(agent, "make my profile private");
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).profileVisibility).toBe("nobody");

    const lang = await say(agent, "switch to hindi");
    expect(lang.message.action!.effects).toContainEqual({ type: "language", value: "hi" });
    const dark = await say(agent, "turn on dark mode");
    expect(dark.message.action!.effects).toContainEqual({ type: "theme", value: "dark" });

    // Security changes need a code or a fingerprint: chat opens the screen.
    const sec = await say(agent, "turn off two factor");
    expect(sec.message.action!.effects).toContainEqual({ type: "navigate", path: "/profile/privacy" });
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).twoFactorEnabled).toBe(false);
  });

  it("asks before making a profile public", async () => {
    const { agent, email } = await authedAgent();
    const r = await say(agent, "make my profile private");
    await say(agent, "make my profile public", r.sessionId);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).profileVisibility).toBe("nobody");
    await say(agent, "yes", r.sessionId);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).profileVisibility).toBe("everyone");
  });

  it("sends checkout to the checkout screen and never pays by itself", async () => {
    const { agent, email } = await authedAgent();
    const r1 = await say(agent, "Find chicken biryani");
    await say(agent, "add it", r1.sessionId);
    const r = await say(agent, "place the order", r1.sessionId);
    expect(r.message.action!.effects).toContainEqual({ type: "navigate", path: "/cart" });
    // Taken to checkout, nothing placed: the cart is untouched and no order exists.
    expect((await cartOf(agent)).count).toBe(1);
    expect(await prisma.order.count({ where: { user: { email } } })).toBe(0);
  });

  it("keeps one customer's chat away from another's cart", async () => {
    const one = await authedAgent();
    const two = await authedAgent();
    const r1 = await say(one.agent, "Find chicken biryani");
    await say(one.agent, "add it", r1.sessionId);
    // Someone else cannot use that conversation.
    await two.agent.post("/api/chat/message").send({ message: "clear my cart", sessionId: r1.sessionId }).expect(404);
    expect((await cartOf(one.agent)).count).toBe(1);
  });

  it("chooses the cheapest platform that has every dish, and refuses only when none has them all", async () => {
    const { commonPlatform } = await import("../src/modules/agent/execute.js");
    const quotes: Record<string, { platform: string; effectivePaise: number }[]> = {
      biryani: [{ platform: "zomato", effectivePaise: 25000 }, { platform: "swiggy", effectivePaise: 26000 }],
      starter: [{ platform: "swiggy", effectivePaise: 18000 }, { platform: "zomato", effectivePaise: 21000 }],
      onlyOndc: [{ platform: "ondc", effectivePaise: 10000 }],
    };
    const q = (id: string) => quotes[id] ?? [];
    // Zomato 25000 + 21000 = 46000; Swiggy 26000 + 18000 = 44000.
    expect(commonPlatform([{ dishId: "biryani", qty: 1 }, { dishId: "starter", qty: 1 }], q)).toEqual({ platform: "swiggy", totalPaise: 44000 });
    expect(commonPlatform([{ dishId: "biryani", qty: 2 }, { dishId: "starter", qty: 0 }], q)?.platform).toBe("zomato");
    expect(commonPlatform([{ dishId: "biryani", qty: 1 }, { dishId: "onlyOndc", qty: 1 }], q)).toBeNull();
  });

  it("still answers ordinary searches as before", async () => {
    const { agent } = await authedAgent();
    const r = await say(agent, "order biryani");
    expect(r.message.domain).toBe("food");
  });
});
