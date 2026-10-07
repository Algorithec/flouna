import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoProvider, readWithConfidence } from "../src/modules/chat/llm/demo.js";

// The rules against every case in the tuned set, on every test run.
//
// The eval script measures the same thing, but only when someone remembers to
// build and run it. A rule changed for one phrasing can quietly break another,
// and the tuned set is where every phrasing we fixed is written down, so the
// suite holds the rules to all of it. The held-out set is deliberately not
// here: it stays a final check that nothing is shaped against.

type Case = { id: string; message: string; expect: Record<string, unknown> };

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/intent-eval.jsonl");
const CASES: Case[] = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

/** Same rule as the eval script: strings match by inclusion, ignoring case. */
function mismatches(want: Record<string, unknown>, got: unknown, path = ""): string[] {
  const out: string[] = [];
  for (const [key, w] of Object.entries(want)) {
    const g = (got as Record<string, unknown> | undefined)?.[key];
    const field = path ? `${path}.${key}` : key;
    if (w !== null && typeof w === "object") {
      out.push(...mismatches(w as Record<string, unknown>, g ?? {}, field));
    } else if (typeof w === "string" && typeof g === "string") {
      if (!g.toLowerCase().includes(w.toLowerCase())) out.push(`${field}: want ${w}, got ${g}`);
    } else if (g !== w) {
      out.push(`${field}: want ${JSON.stringify(w)}, got ${JSON.stringify(g)}`);
    }
  }
  return out;
}

describe("the rules on the tuned set", () => {
  it("has the cases to check", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
  });

  it.each(CASES.map((c) => [c.id, c] as const))("%s", async (_, c) => {
    const intent = await new DemoProvider().extractIntent(c.message);
    expect(mismatches(c.expect, intent), c.message).toEqual([]);
  });
});

describe("Hindi and Telugu words do not leak into English", () => {
  it.each([
    // "ki" and "tak" are place markers only after a place.
    ["book a cab to the airport", "airport"],
    ["cab to Banjara Hills please", "Banjara Hills"],
  ])("still reads %s", async (message, drop) => {
    const intent = await new DemoProvider().extractIntent(message);
    expect(intent.ride?.drop.toLowerCase()).toContain(drop.toLowerCase());
  });

  it("does not read a count before a Hindi word as a budget", async () => {
    const intent = await new DemoProvider().extractIntent("2 plates tak biryani");
    expect(intent.food?.budgetPaise).toBeNull();
  });

  it("is confident about the phrasings it now reads", () => {
    expect(readWithConfidence("pizza 250 ke andar").confident).toBe(true);
    expect(readWithConfidence("Gachibowli ki cab kavali").confident).toBe(true);
  });
});
