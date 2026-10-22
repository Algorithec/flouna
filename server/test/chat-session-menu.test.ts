import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { slaFor } from "../src/lib/policy.js";
import { authedAgent } from "./helpers.js";

// The menu on a recent chat (pin, rename, archive, delete) and the report of
// a technical problem. Each is written as what someone might try, including
// against a chat that is not theirs.

async function userWithChats(n: number) {
  const a = await authedAgent();
  const user = await prisma.user.findUniqueOrThrow({ where: { email: a.email } });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = await prisma.chatSession.create({
      data: { userId: user.id, title: `chat ${i}`, updatedAt: new Date(Date.UTC(2026, 9, 1, 10, i)) },
    });
    ids.push(s.id);
  }
  return { ...a, userId: user.id, ids };
}

describe("the recent chat menu", () => {
  it("lists pinned chats first, and archived ones only when asked", async () => {
    const u = await userWithChats(3);
    // Newest first before anything is pinned.
    let list = (await u.agent.get("/api/chat/sessions").expect(200)).body;
    expect(list.sessions.map((s: { id: string }) => s.id)).toEqual([u.ids[2], u.ids[1], u.ids[0]]);

    await u.agent.patch(`/api/chat/sessions/${u.ids[0]}`).send({ pinned: true }).expect(200);
    await u.agent.patch(`/api/chat/sessions/${u.ids[1]}`).send({ archived: true }).expect(200);
    list = (await u.agent.get("/api/chat/sessions").expect(200)).body;
    expect(list.sessions.map((s: { id: string; pinned: boolean }) => [s.id, s.pinned])).toEqual([
      [u.ids[0], true],
      [u.ids[2], false],
    ]);
    expect(list.archivedCount).toBe(1);

    const archived = (await u.agent.get("/api/chat/sessions?archived=1").expect(200)).body;
    expect(archived.sessions.map((s: { id: string; archived: boolean }) => [s.id, s.archived])).toEqual([[u.ids[1], true]]);
  });

  it("archiving unpins, and unarchiving brings the chat back among the recent ones", async () => {
    const u = await userWithChats(1);
    const id = u.ids[0]!;
    await u.agent.patch(`/api/chat/sessions/${id}`).send({ pinned: true }).expect(200);
    const res = await u.agent.patch(`/api/chat/sessions/${id}`).send({ archived: true }).expect(200);
    expect(res.body.session).toMatchObject({ pinned: false, archived: true });
    await u.agent.patch(`/api/chat/sessions/${id}`).send({ archived: false }).expect(200);
    const list = (await u.agent.get("/api/chat/sessions").expect(200)).body;
    expect(list.sessions).toEqual([expect.objectContaining({ id, pinned: false, archived: false })]);
  });

  it("writing in an archived chat makes it current again", async () => {
    const u = await userWithChats(1);
    const id = u.ids[0]!;
    await u.agent.patch(`/api/chat/sessions/${id}`).send({ archived: true }).expect(200);
    await u.agent.post("/api/chat/message").send({ message: "hello", sessionId: id }).expect(200);
    expect((await prisma.chatSession.findUniqueOrThrow({ where: { id } })).archivedAt).toBeNull();
  });

  it("renames a chat, and keeps the new name when the chat is written in", async () => {
    const u = await userWithChats(1);
    const id = u.ids[0]!;
    await u.agent.patch(`/api/chat/sessions/${id}`).send({ title: "  Friday biryani  " }).expect(200);
    await u.agent.post("/api/chat/message").send({ message: "hello again", sessionId: id }).expect(200);
    expect((await prisma.chatSession.findUniqueOrThrow({ where: { id } })).title).toBe("Friday biryani");
    // Empty, overlong or unexpected fields are refused, not half applied.
    await u.agent.patch(`/api/chat/sessions/${id}`).send({ title: "   " }).expect(400);
    await u.agent.patch(`/api/chat/sessions/${id}`).send({ title: "x".repeat(81) }).expect(400);
    await u.agent.patch(`/api/chat/sessions/${id}`).send({ userId: "someone" }).expect(400);
    await u.agent.patch(`/api/chat/sessions/${id}`).send({}).expect(400);
  });

  it("deletes a chat and its messages for good", async () => {
    const u = await userWithChats(1);
    const id = u.ids[0]!;
    await prisma.chatMessage.create({ data: { sessionId: id, role: "user", content: "hi" } });
    await u.agent.delete(`/api/chat/sessions/${id}`).expect(204);
    expect(await prisma.chatSession.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.chatMessage.count({ where: { sessionId: id } })).toBe(0);
    await u.agent.get(`/api/chat/sessions/${id}`).expect(404);
    await u.agent.delete(`/api/chat/sessions/${id}`).expect(404);
  });

  it("cannot pin, rename, archive or delete someone else's chat, and cannot tell it exists", async () => {
    const owner = await userWithChats(1);
    const id = owner.ids[0]!;
    const other = await authedAgent();
    for (const body of [{ pinned: true }, { title: "mine now" }, { archived: true }]) {
      const res = await other.agent.patch(`/api/chat/sessions/${id}`).send(body).expect(404);
      expect(res.body.error ?? res.body.message).toMatch(/not found/i);
    }
    await other.agent.delete(`/api/chat/sessions/${id}`).expect(404);
    await other.agent.patch(`/api/chat/sessions/not-a-real-id`).send({ pinned: true }).expect(404);
    const after = await prisma.chatSession.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ title: "chat 0", pinnedAt: null, archivedAt: null });
  });

  it("needs a signed-in user", async () => {
    const u = await userWithChats(1);
    const { default: request } = await import("supertest");
    const { app } = await import("./helpers.js");
    await request(app).patch(`/api/chat/sessions/${u.ids[0]}`).send({ pinned: true }).expect(401);
    await request(app).delete(`/api/chat/sessions/${u.ids[0]}`).expect(401);
  });
});

describe("reporting a technical problem", () => {
  it("raises a technical ticket on the published general deadlines", async () => {
    const a = await authedAgent();
    const res = await a.agent
      .post("/api/users/tickets")
      .send({ category: "technical", subject: "Technical problem on /home", body: "The send button does nothing.\n\nPage: /home" })
      .expect(201);
    const ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: res.body.ticket.id } });
    expect(ticket).toMatchObject({ category: "technical", priority: "normal", status: "open" });
    // On the published deadlines for a general question, never none. The
    // deadline and createdAt are stamped a moment apart, so within a second.
    const sla = slaFor("general");
    expect(Math.abs(ticket.slaRespondBy!.getTime() - ticket.createdAt.getTime() - sla.respondMs)).toBeLessThan(1000);
    expect(Math.abs(ticket.slaResolveBy!.getTime() - ticket.createdAt.getTime() - sla.resolveMs)).toBeLessThan(1000);
  });
});
