import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { scrub, trainingExamples } from "../src/modules/chat/trainingExport.js";

// Real chat traffic becomes training data for our own intent model only as the
// privacy policy allows (6.4): anonymised, and never from a customer who opted
// out. These are written as what could go wrong: a reading leaking to the
// browser, an opted out customer's words in the set, a phone number or an id
// surviving the export.

describe("training data from chat", () => {
  it("stores the reading beside the reply, and never sends it to the browser", async () => {
    const { agent } = await authedAgent();
    const sent = await agent.post("/api/chat/message").send({ message: "order biryani under 300" }).expect(200);
    expect(sent.body.message.reading).toBeUndefined();
    const sessionId = sent.body.sessionId as string;

    const stored = await prisma.chatMessage.findFirstOrThrow({
      where: { sessionId, role: "assistant" },
      orderBy: { createdAt: "desc" },
    });
    const reading = JSON.parse(stored.intent!).reading;
    expect(reading.domain).toBe("food");
    expect(reading.food.budgetPaise).toBe(30000);

    const restored = await agent.get(`/api/chat/sessions/${sessionId}`).expect(200);
    for (const m of restored.body.session.messages) expect(m.reading).toBeUndefined();
  });

  it("pairs each message with its reading, leaves out customers who opted out, and keeps no ids", async () => {
    const since = new Date(Date.now() - 60_000);
    const { agent: included } = await authedAgent();
    await included
      .post("/api/chat/message")
      .send({ message: "biryani under 300, call 98765 43210 or me@example.com" })
      .expect(200);
    const { agent: optedOut, email } = await authedAgent();
    await prisma.user.update({ where: { email }, data: { aiTrainingOptOut: true } });
    await optedOut.post("/api/chat/message").send({ message: "opted out dosa under 150" }).expect(200);

    const examples = await trainingExamples({ since, until: new Date(Date.now() + 60_000) });
    const asked = examples.map((e) => e.messages[0].content);
    expect(asked).toContain("biryani under 300, call <phone> or <email>");
    expect(asked.some((a) => a.includes("opted out"))).toBe(false);

    const mine = examples.find((e) => e.messages[0].content.startsWith("biryani under 300"))!;
    expect(JSON.parse(mine.messages[1].content).food.budgetPaise).toBe(30000);
    expect(mine.meta.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(examples)).not.toMatch(/"(userId|sessionId|id)"/);
  });

  it("replaces contact details and identifying numbers but keeps prices", () => {
    expect(scrub("pay me at ravi@okaxis")).toBe("pay me at <upi>");
    expect(scrub("+919876543210")).toBe("<phone>");
    expect(scrub("call +91 98765 43210 now")).toBe("call <phone> now");
    expect(scrub("aadhaar 1234 5678 9012")).toBe("aadhaar <number>");
    expect(scrub("account 123456789012")).toBe("account <number>");
    expect(scrub("deliver to 500081")).toBe("deliver to <pincode>");
    expect(scrub("biryani under 300, or 300 400 500 for three")).toBe("biryani under 300, or 300 400 500 for three");
  });
});
