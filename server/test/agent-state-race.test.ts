import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { loadState, saveState, type AgentState } from "../src/modules/agent/state.js";
import { authedAgent } from "./helpers.js";

// The booking card reports a trip while a chat message is being answered.
// The message read the memory before the trip arrived; saving its copy must
// not wipe the trip out.

describe("chat memory under concurrent writes", () => {
  it("keeps a trip the card reported while a message was being answered", async () => {
    const { email } = await authedAgent();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const session = await prisma.chatSession.create({ data: { userId: user.id } });

    const readAt = new Date().toISOString();
    const readByMessage = await loadState(session.id);
    await new Promise((r) => setTimeout(r, 5));
    // Meanwhile the card reports its trip.
    const ride = {
      at: new Date().toISOString(),
      card: "c",
      pickup: { name: "A", lat: 17.4, lng: 78.3 },
      drop: { name: "B", lat: 17.3, lng: 78.4 },
      options: [{ provider: "uber", productName: "x", displayName: "Cab", vehicle: "cab", effectivePaise: 20000 }],
    };
    await saveState(session.id, { ...(await loadState(session.id)), ride });
    // The message saves what it read, plus what it changed.
    const changed: AgentState = { ...readByMessage, groupId: "g1" };
    await saveState(session.id, changed, { readAt });

    const after = await loadState(session.id);
    expect(after.groupId).toBe("g1");
    expect(after.ride?.card).toBe("c");
  });

  it("still lets a newer save replace an older trip", async () => {
    const { email } = await authedAgent();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const session = await prisma.chatSession.create({ data: { userId: user.id } });
    const base = { pickup: { name: "A", lat: 1, lng: 1 }, drop: { name: "B", lat: 2, lng: 2 }, options: [{ provider: "uber", productName: "x", displayName: "Cab", vehicle: "cab", effectivePaise: 1 }] };
    await saveState(session.id, { v: 1, ride: { ...base, at: "2026-01-01T00:00:00.000Z", card: "old" } });
    await saveState(session.id, { v: 1, ride: { ...base, at: "2026-01-02T00:00:00.000Z", card: "new" } });
    expect((await loadState(session.id)).ride?.card).toBe("new");
  });
});
