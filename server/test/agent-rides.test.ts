import { describe, expect, it } from "vitest";
import { parseInstruction } from "../src/modules/agent/parse.js";
import { authedAgent } from "./helpers.js";

// The founder's Example B: rides by text, through the real chat endpoint. The
// options are the rides route's real quotes, reported by the booking card the
// way the app does it.

type Agent = Awaited<ReturnType<typeof authedAgent>>["agent"];
type Effect = { type: string; card?: string; command?: string; provider?: string; productName?: string };
type Reply = {
  sessionId: string;
  message: { content: string; domain: string; action?: { kind: string; ok: boolean; card?: any; effects?: Effect[] } };
};

const say = async (agent: Agent, message: string, sessionId?: string) =>
  (await agent.post("/api/chat/message").send({ message, ...(sessionId ? { sessionId } : {}) }).expect(200)).body as Reply;

const PICKUP = { name: "Hitech City", lat: 17.4435, lng: 78.3772 };
const DROP = { name: "Charminar", lat: 17.3616, lng: 78.4747 };

/** Opens a ride chat and reports the card's real options, as the app does. */
async function rideChat(agent: Agent) {
  const r = await say(agent, "ride to Charminar");
  const q = (await agent.get("/api/rides/quotes?distanceKm=14&rideMinutes=35").expect(200)).body as {
    quotes: { provider: string; productName: string; displayName: string; vehicle: string; effectivePaise: number; pickupEtaMinutes: number }[];
  };
  const options = q.quotes.map(({ provider, productName, displayName, vehicle, effectivePaise, pickupEtaMinutes }) => ({
    provider,
    productName,
    displayName,
    vehicle,
    effectivePaise,
    pickupEtaMinutes,
  }));
  await agent.post(`/api/chat/sessions/${r.sessionId}/ride`).send({ card: "card-1", pickup: PICKUP, drop: DROP, options }).expect(204);
  return { sid: r.sessionId, options };
}

describe("rides by text (founder's Example B)", () => {
  it("chooses the second option on screen, states the fare, and books only after a yes", async () => {
    const { agent } = await authedAgent();
    const { sid, options } = await rideChat(agent);
    const second = options[1]!;

    const chose = await say(agent, "Choose the second option", sid);
    expect(chose.message.action).toMatchObject({ kind: "select", ok: true });
    expect(chose.message.content).toContain(second.displayName);
    expect(chose.message.content).toMatch(/Book it\?/);
    expect(chose.message.action!.card).toMatchObject({ type: "confirm" });
    expect(chose.message.action!.effects).toContainEqual({ type: "ride_command", card: "card-1", command: "select", provider: second.provider, productName: second.productName });

    // Nothing booked yet: no book command was sent.
    expect(chose.message.action!.effects!.some((e) => e.command === "book")).toBe(false);

    const yes = await say(agent, "yes", sid);
    expect(yes.message.action!.effects).toContainEqual({ type: "ride_command", card: "card-1", command: "book", provider: second.provider, productName: second.productName });
    // Never claims the ride is booked before payment confirms it.
    expect(yes.message.content).toMatch(/isn't booked until then/);
  });

  it("picks the cheapest and the fastest", async () => {
    const { agent } = await authedAgent();
    const { sid, options } = await rideChat(agent);
    const cheapest = [...options].sort((a, b) => a.effectivePaise - b.effectivePaise)[0]!;
    const fastest = [...options].sort((a, b) => a.pickupEtaMinutes - b.pickupEtaMinutes)[0]!;
    expect((await say(agent, "take the cheapest one", sid)).message.action!.effects![0]).toMatchObject({ productName: cheapest.productName });
    expect((await say(agent, "go with the fastest", sid)).message.action!.effects![0]).toMatchObject({ productName: fastest.productName });
  });

  it("asks before \"book it\", and says so when there is no trip yet", async () => {
    const { agent } = await authedAgent();
    const none = await say(agent, "book it");
    expect(none.message.action).toMatchObject({ kind: "ride.book", ok: false });
    const { sid } = await rideChat(agent);
    const ask = await say(agent, "book it", sid);
    expect(ask.message.action!.card).toMatchObject({ type: "confirm" });
    expect(ask.message.action!.effects ?? []).toEqual([]);
    await say(agent, "no", sid);
    const stray = await say(agent, "yes", sid);
    expect(stray.message.action!.ok).toBe(false);
  });

  it("asks what \"rides for four, one only for me\" means, then sets up a shared ride", async () => {
    const { agent } = await authedAgent();
    const { sid, options } = await rideChat(agent);
    const cab = options.findIndex((o) => o.vehicle === "cab");
    expect(cab).toBeGreaterThanOrEqual(0);
    await say(agent, `choose option ${cab + 1}`, sid);

    const ask = await say(agent, "Book rides for four people, but book one ride only for me", sid);
    expect(ask.message.action).toMatchObject({ kind: "ride.group", ok: true });
    expect(ask.message.action!.card).toEqual({
      type: "choice",
      options: [
        { label: "One shared ride", reply: "one shared ride" },
        { label: "Just my ride", reply: "just my ride" },
      ],
    });

    const shared = await say(agent, "one shared ride", sid);
    expect(shared.message.action).toMatchObject({ kind: "ride.group_mode", ok: true });
    const card = shared.message.action!.card as { type: string; group: { domain: string; expectedMembers: number; code: string } };
    expect(card.type).toBe("group");
    expect(card.group).toMatchObject({ domain: "ride", expectedMembers: 4 });
  });

  it("books just the customer's ride when that is the answer, after a yes", async () => {
    const { agent } = await authedAgent();
    const { sid } = await rideChat(agent);
    await say(agent, "book rides for 3 of us", sid);
    const mine = await say(agent, "just my ride", sid);
    expect(mine.message.action!.card).toMatchObject({ type: "confirm" });
    const yes = await say(agent, "yes", sid);
    expect(yes.message.action!.effects!.some((e) => e.command === "book")).toBe(true);
  });

  it("refuses a shared ride the vehicle cannot seat", async () => {
    const { agent } = await authedAgent();
    const { sid, options } = await rideChat(agent);
    const auto = options.findIndex((o) => o.vehicle === "auto");
    expect(auto).toBeGreaterThanOrEqual(0);
    await say(agent, `choose option ${auto + 1}`, sid);
    await say(agent, "book rides for 4 people", sid);
    const r = await say(agent, "one shared ride", sid);
    expect(r.message.action!.ok).toBe(false);
    expect(r.message.content).toMatch(/seats 3/);
  });

  it("only takes trip details from the customer's own chat", async () => {
    const one = await authedAgent();
    const two = await authedAgent();
    const { sid } = await rideChat(one.agent);
    await two.agent
      .post(`/api/chat/sessions/${sid}/ride`)
      .send({ card: "x", pickup: PICKUP, drop: DROP, options: [{ provider: "uber", productName: "x", displayName: "x", vehicle: "cab", effectivePaise: 1 }] })
      .expect(404);
    await one.agent.post(`/api/chat/sessions/${sid}/ride`).send({ card: "x", pickup: PICKUP, drop: DROP, options: [] }).expect(400);
  });

  it("chooses from whichever list was shown last", async () => {
    const { agent } = await authedAgent();
    const { sid } = await rideChat(agent);
    // Food shown after the rides: "the first one" is now a dish.
    await say(agent, "Find chicken biryani", sid);
    const sel = await say(agent, "choose the first one", sid);
    expect(sel.message.content).toMatch(/Say "add it"/);
    expect(sel.message.action!.effects ?? []).toEqual([]);
  });

  it("does not pick an old dish when the newest thing asked for was a ride", async () => {
    const { agent } = await authedAgent();
    const r = await say(agent, "Find chicken biryani");
    // A ride asked for, but the card has not priced the trip yet.
    await say(agent, "ride to Charminar", r.sessionId);
    const sel = await say(agent, "choose the second option", r.sessionId);
    expect(sel.message.action!.ok).toBe(false);
    expect(sel.message.content).toMatch(/pickup and drop/);
    // And "add it" does not add the biryani from before the ride either.
    const add = await say(agent, "add it", r.sessionId);
    expect(add.message.action!.ok).toBe(false);
    expect(((await agent.get("/api/cart").expect(200)).body as { count: number }).count).toBe(0);
  });

  it("does not pick a dish when the newest list was products", async () => {
    const { agent } = await authedAgent();
    const r = await say(agent, "Find chicken biryani");
    await say(agent, "running shoes under 3000", r.sessionId);
    const sel = await say(agent, "choose the second one", r.sessionId);
    expect(sel.message.action!.ok).toBe(false);
  });

  it("selects a dish without adding it, then adds it on request", async () => {
    const { agent } = await authedAgent();
    const r = await say(agent, "Find chicken biryani");
    const sel = await say(agent, "choose the first one", r.sessionId);
    expect(sel.message.content).toMatch(/Say "add it"/);
    expect(((await agent.get("/api/cart").expect(200)).body as { count: number }).count).toBe(0);
    await say(agent, "add it", r.sessionId);
    expect(((await agent.get("/api/cart").expect(200)).body as { count: number }).count).toBe(1);
  });
});

describe("reading ride instructions", () => {
  it.each([
    ["Choose the second option", { kind: "select", index: 1, pick: null }],
    ["select option 3", { kind: "select", index: 2, pick: null }],
    ["take the cheapest one", { kind: "select", index: null, pick: "cheapest" }],
    ["go with the fastest", { kind: "select", index: null, pick: "fastest" }],
    ["book it", { kind: "ride.book" }],
    ["book the ride", { kind: "ride.book" }],
    ["Book rides for four people, but book one ride only for me", { kind: "ride.group", members: 4 }],
    ["get cabs for 3 of us", { kind: "ride.group", members: 3 }],
    ["one shared ride", { kind: "ride.group_mode", mode: "shared" }],
    ["just my ride", { kind: "ride.group_mode", mode: "mine" }],
  ])("%s", (text, action) => expect(parseInstruction(text)).toEqual(action));

  it.each([
    "book a cab to the airport",
    "Find the cheapest ride to the airport under ₹700",
    "ride to charminar",
    "book an auto for 2 people to charminar",
    "i'll take a cab",
  ])("%s is a ride search", (text) =>
    expect(parseInstruction(text)).toBeNull(),
  );
});
