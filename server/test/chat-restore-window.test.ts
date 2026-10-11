import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Restoring a conversation is capped at a hundred messages, which is sensible.
// It took the FIRST hundred in time order, which is not: a customer who has
// been using the assistant for a while reopened their chat to the day they
// started it, with everything since — including the answer they were reading
// when they switched screens — absent.
//
// Written against the data rather than through 101 round trips: the route's job
// here is to pick a window, and the window is what is wrong.

describe("restoring a long conversation", () => {
  it("returns the latest messages, in reading order", async () => {
    const { agent } = await authedAgent({ withAddress: false });
    const started = await agent
      .post("/api/chat/message")
      .send({ message: "hello" })
      .expect(200);
    const sessionId = started.body.sessionId as string;

    // 120 further turns, timestamped apart so "latest" is unambiguous.
    const base = Date.now();
    await prisma.chatMessage.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        sessionId,
        role: "user",
        content: `turn ${i}`,
        createdAt: new Date(base + (i + 1) * 1000),
      })),
    });

    const res = await agent.get(`/api/chat/sessions/${sessionId}`).expect(200);
    const messages = res.body.session.messages as { content: string }[];

    expect(messages).toHaveLength(100);
    // The most recent thing said is on the page.
    expect(messages.at(-1)!.content).toBe("turn 119");
    // And it reads forwards, oldest of the window first.
    expect(messages[0]!.content).toBe("turn 20");
  });

  it("leaves a short conversation exactly as it was", async () => {
    const { agent } = await authedAgent({ withAddress: false });
    const first = await agent
      .post("/api/chat/message")
      .send({ message: "biryani under 300" })
      .expect(200);
    const sessionId = first.body.sessionId as string;
    await agent
      .post("/api/chat/message")
      .send({ message: "a cab to the airport", sessionId })
      .expect(200);

    const res = await agent.get(`/api/chat/sessions/${sessionId}`).expect(200);
    const messages = res.body.session.messages as {
      role: string;
      content: string;
    }[];
    expect(messages).toHaveLength(4);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("biryani under 300");
    expect(messages[2]!.content).toBe("a cab to the airport");
  });
});
