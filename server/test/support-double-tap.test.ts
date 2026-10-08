import { describe, expect, it } from "vitest";
import request from "supertest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// One conversation raises one ticket, however the buttons are tapped.
//
// Asking for a person, and rating a chat poorly, each raise a ticket for the
// support team. Both checked whether the chat already had one and then raised
// it, so two taps at once raised two: the team saw every such case twice, and
// a second rating silently overwrote the first.

async function startChat(agent: ReturnType<typeof request.agent>) {
  const res = await agent.post("/api/support/chats").send({}).expect(201);
  return res.body.chat as { id: string };
}

async function ticketsFor(email: string) {
  const me = await prisma.user.findUniqueOrThrow({ where: { email } });
  return prisma.supportTicket.count({ where: { userId: me.id } });
}

describe("asking for a person with a double tap", () => {
  it("raises one ticket", async () => {
    const { agent, email } = await authedAgent();
    const chat = await startChat(agent);
    await agent.post(`/api/support/chats/${chat.id}/messages`).send({ body: "my coupon code isn't working" }).expect(200);

    await Promise.all([
      agent.post(`/api/support/chats/${chat.id}/messages`).send({ body: "__escalate" }),
      agent.post(`/api/support/chats/${chat.id}/messages`).send({ body: "__escalate" }),
    ]);

    expect(await ticketsFor(email)).toBe(1);
  });
});

describe("rating a chat poorly with a double tap", () => {
  it("keeps the first rating and raises one ticket", async () => {
    const { agent, email } = await authedAgent();
    const chat = await startChat(agent);

    const results = await Promise.all([
      agent.post(`/api/support/chats/${chat.id}/rating`).send({ stars: 1, comment: "useless" }),
      agent.post(`/api/support/chats/${chat.id}/rating`).send({ stars: 2 }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ticketsFor(email)).toBe(1);
  });
});
