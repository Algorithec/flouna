import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPLY_CODES } from "../src/modules/chat/replies.js";
import { authedAgent } from "./helpers.js";

// The chat answered every reader in English, whatever language they chose.
// Its own sentences now carry a code the app translates. The English is still
// sent for anything that does not know the codes.

type Agent = Awaited<ReturnType<typeof authedAgent>>["agent"];

async function ask(agent: Agent, message: string, extra: Record<string, unknown> = {}) {
  const res = await agent.post("/api/chat/message").send({ message, ...extra }).expect(200);
  return res.body as { sessionId: string | null; message: { content: string; replyCode: unknown } };
}

describe("chat replies in the reader's language", () => {
  it("sends a code with each fixed sentence, the firewall's included", async () => {
    const { agent } = await authedAgent();
    expect((await ask(agent, "hi")).message.replyCode).toEqual({ code: "greeting" });
    expect((await ask(agent, "who won the cricket world cup")).message.replyCode).toEqual({ code: "outOfScope" });
    expect((await ask(agent, "   ")).message.replyCode).toEqual({ code: "empty" });
    expect((await ask(agent, "biryani ".repeat(80))).message.replyCode).toEqual({ code: "tooLong" });
  });

  it("names the dish it could not find, and the limit nothing met", async () => {
    const { agent } = await authedAgent();
    // The only momos on the menu are chicken.
    const missing = await ask(agent, "veg momos");
    expect(missing.message.replyCode).toEqual({ code: "foodNotFound", params: { item: "momo" } });

    const over = await ask(agent, "pizza under ₹50");
    expect(over.message.replyCode).toMatchObject({ code: "foodOverPrice", params: { item: "pizza", limit: "₹50" } });
    // The figures in the code are the ones the English states.
    const params = (over.message.replyCode as { params: Record<string, string> }).params;
    for (const value of Object.values(params)) expect(over.message.content).toContain(value);
  });

  it("keeps the code when the chat is opened again", async () => {
    const { agent } = await authedAgent();
    const { sessionId } = await ask(agent, "hi");
    const res = await agent.get(`/api/chat/sessions/${sessionId}`).expect(200);
    const reply = res.body.session.messages.find((m: { role: string }) => m.role === "assistant");
    expect(reply.replyCode).toEqual({ code: "greeting" });
  });

  it("codes a temporary chat's reply too", async () => {
    const { agent } = await authedAgent();
    expect((await ask(agent, "hi", { temporary: true })).message.replyCode).toEqual({ code: "greeting" });
  });

  it("has every reply translated in all six of the app's languages", () => {
    const dictionaries = readFileSync(new URL("../../web/lib/i18n/dictionaries.ts", import.meta.url), "utf8");
    for (const code of REPLY_CODES) {
      expect(dictionaries.split(`"chat.r.${code}":`).length - 1, code).toBe(6);
    }
  });
});
