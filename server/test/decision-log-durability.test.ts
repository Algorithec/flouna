import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";

// A decision that was made must be recorded.
//
// The write is fire-and-forget so logging can never slow or fail a search,
// and it used to make one attempt and swallow any error. Under contention the
// database refuses writes for a moment (SQLite reports it as locked, Postgres
// as a pool timeout or a dropped connection), and each refusal silently
// deleted a decision: the audit trail got a hole, and the order that later
// quoted that id retried for half a minute against a row that would never
// exist. It showed up as a pairing test that failed only under the full suite.

const trace = {
  priority: "balanced",
  weights: { price: 0.45, rating: 0.35, speed: 0.2 },
  personalized: false,
  candidateCount: 1,
  excludedCount: 0,
  exclusions: [],
  scores: [],
  chosenKey: "k",
} as never;

async function landed(ids: string[], timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await prisma.decisionLog.count({ where: { id: { in: ids } } });
    if (n === ids.length || Date.now() > deadline) return n;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("recording a decision under contention", () => {
  it("records every decision even when the database is briefly refusing writes", async () => {
    const { recordDecision } = await import("../src/modules/advisor/decisionLog.service.js");

    // Contention, made rather than hoped for: a long write transaction holds
    // SQLite's lock while the decisions arrive, then lets go.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.decisionLog.create({
          data: {
            id: `holder-${Date.now()}`,
            domain: "food",
            query: "holder",
            priority: "balanced",
            weights: "{}",
            candidateCount: 0,
            excludedCount: 0,
            results: "[]",
            chosenKey: "x",
          },
        });
        await new Promise((r) => setTimeout(r, 6000));
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));
    const ids = Array.from({ length: 10 }, (_, i) =>
      recordDecision({ userId: null, domain: "food", query: `contended ${i}`, trace }),
    );
    await holder;

    expect(await landed(ids)).toBe(ids.length);
  }, 60_000);
});
