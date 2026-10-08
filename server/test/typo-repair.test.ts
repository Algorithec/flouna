import { describe, expect, it } from "vitest";
import { DemoProvider } from "../src/modules/chat/llm/demo.js";

// Typo repair helps a customer who misspells a dish. It must not turn an
// ordinary sentence into a food order.
//
// Review on #52 asked for negative tests with everyday words near the food
// vocabulary. Measured before the fix, fourteen of these fifteen became food
// searches. A misspelled dish left alone gets "what would you like?"; a normal
// sentence repaired into a dish starts a search nobody asked for.

const engine = new DemoProvider();
const read = (m: string) => engine.extractIntent(m);

describe("ordinary words are not repaired into dishes", () => {
  it.each([
    ["that was a nice day", "nice / rice"],
    ["what is the meaning of karma", "karma / korma"],
    ["please write a memo", "memo / momo"],
    ["i need to hurry", "hurry / curry"],
    ["carry this for me", "carry / curry"],
    ["wash with soap", "soap / soup"],
    ["the nice race was fun", "race / rice"],
    ["what time is the race", "race / rice"],
    ["that is so nice", "nice / rice"],
    ["what does dose mean", "dose / dosa"],
    ["is the price right", "price / rice"],
    ["feeling sour today", "sour / soup"],
    ["make it quick", "make / cake"],
    ["my partner is italics", "italics / italian"],
    ["the company is binary", "binary / biryani"],
  ])("%s  (%s)", async (message) => {
    expect((await read(message)).domain).not.toBe("food");
  });
});

describe("genuine misspellings of long dish names are still repaired", () => {
  it.each([
    ["biriyani", "biryani"],
    ["chiken biriyani under 250", "biryani"],
  ])("%s", async (message, item) => {
    const intent = await read(message);
    expect(intent.domain).toBe("food");
    expect(intent.food?.item).toBe(item);
  });

  it("does not repair a short word, accepting that some short typos go unfixed", async () => {
    // "piza" is one edit from pizza, and it is also the kind of four letter
    // word that collides with ordinary English. The cost of the rule, stated
    // rather than hidden: this one now gets an ordinary reply.
    expect((await read("i want piza")).domain).not.toBe("food");
  });
});
