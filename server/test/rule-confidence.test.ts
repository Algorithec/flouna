import { describe, expect, it } from "vitest";
import { readWithConfidence } from "../src/modules/chat/llm/demo.js";

// How sure the rules are of a reading.
//
// The rules answer in well under a millisecond and a model takes seconds, so
// the rules should answer every message they read cleanly and pass on only
// the ones they might have misread. That needs the rules to know which is
// which. The signals are deliberately about the message rather than about the
// answer: a number nobody accounted for, words the rules do not speak, a typo
// that had to be repaired. Each is a sign that something was said which the
// reading does not contain.

describe("messages the rules read cleanly", () => {
  it.each([
    "order biryani under 300",
    "Get me chicken biryani under ₹300 within 30 minutes",
    "cheapest pizza near me",
    "book a cab to Gachibowli",
    "hi",
    "buy a laptop under 50000",
  ])("is confident about %s", (message) => {
    const r = readWithConfidence(message);
    expect(r.reasons).toEqual([]);
    expect(r.confident).toBe(true);
  });
});

describe("messages the rules may have misread", () => {
  it("doubts a number that became no limit", () => {
    const r = readWithConfidence("biryani 300 tak");
    expect(r.confident).toBe(false);
    expect(r.reasons).toContain("unread-number");
  });

  it("accepts a number that is a count or a clock time", () => {
    expect(readWithConfidence("12 samosas please").reasons).not.toContain("unread-number");
    expect(readWithConfidence("cab to the airport at 10:30").reasons).not.toContain("unread-number");
  });

  it("doubts words the rules do not speak", () => {
    const r = readWithConfidence("biryani chahiye jaldi");
    expect(r.confident).toBe(false);
    expect(r.reasons).toContain("other-language");
  });

  it("doubts a reading that needed a typo repaired", () => {
    const r = readWithConfidence("I want biriyani");
    expect(r.intent.domain).toBe("food");
    expect(r.reasons).toContain("typo-repaired");
  });

  it("doubts a refusal, which a model may read as a request", () => {
    const r = readWithConfidence("something to fill my stomach");
    expect(r.intent.domain).toBe("out_of_scope");
    expect(r.reasons).toContain("refused");
  });

  it("doubts a ride whose destination it could not find", () => {
    const r = readWithConfidence("need a cab for my mom");
    expect(r.reasons).toContain("no-destination");
  });

  it("doubts a message that asks for two priorities at once", () => {
    const r = readWithConfidence("cheap but fast biryani");
    expect(r.reasons).toContain("mixed-priority");
  });

  it("returns the same reading the provider gives", async () => {
    const { DemoProvider } = await import("../src/modules/chat/llm/demo.js");
    for (const m of ["biryani 300 tak", "I want biriyani", "hi", "cab to Ameerpet"]) {
      expect(readWithConfidence(m).intent).toEqual(await new DemoProvider().extractIntent(m));
    }
  });
});
