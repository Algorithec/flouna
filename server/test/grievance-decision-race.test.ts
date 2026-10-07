import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { concludeGrievance, decideAppeal, openAppeal } from "../src/modules/complaints/grievance.ops.js";
import { createComplaint } from "../src/modules/complaints/complaints.service.js";

// Two officers acting on the same grievance at once.
//
// Each step checked the case ("not yet concluded") and then wrote to it, so
// two conclusions sent together both succeeded and the second replaced the
// first officer's outcome without either knowing; the same for deciding an
// appeal; and opening the appeal twice pushed its legal deadline later. These
// are the records a regulator reads, so each step is now taken by a write
// that only one request can win.

async function newCase() {
  const { email } = await authedAgent();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const complaint = await createComplaint({
    userId: user.id,
    category: "ITEM",
    subCategory: "ITEM_DAMAGED",
    description: "The container was open and half of it had spilled.",
  });
  return complaint.id;
}

const settled = (ps: Promise<unknown>[]) => Promise.allSettled(ps);
const statusOf = (r: PromiseSettledResult<unknown>) =>
  r.status === "fulfilled" ? 200 : ((r.reason as { status?: number }).status ?? 500);

describe("concluding a grievance twice at once", () => {
  it("keeps one outcome and refuses the other", async () => {
    const id = await newCase();
    const outcomes = ["Refunded the spilled portion in full.", "No fault found with the packaging."];
    const results = await settled(outcomes.map((o) => concludeGrievance(id, o)));
    expect(results.map(statusOf).sort()).toEqual([200, 409]);
    // The outcome on record is the one whose officer was told it succeeded.
    const won = results.findIndex((r) => r.status === "fulfilled");
    const stored = await prisma.complaint.findUniqueOrThrow({ where: { id } });
    expect(stored.resolution).toBe(outcomes[won]);
  });
});

describe("the appeal", () => {
  it("opens once, with one deadline", async () => {
    const id = await newCase();
    await concludeGrievance(id, "Refunded the spilled portion in full.");
    const results = await settled([openAppeal(id), openAppeal(id)]);
    expect(results.map(statusOf).sort()).toEqual([200, 409]);
  });

  it("is decided once", async () => {
    const id = await newCase();
    await concludeGrievance(id, "Refunded the spilled portion in full.");
    await openAppeal(id);
    const results = await settled([
      decideAppeal(id, "Upheld: the refund stands."),
      decideAppeal(id, "Overturned: a further credit is due."),
    ]);
    expect(results.map(statusOf).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ appealOutcome: string | null }>;
    const stored = await prisma.complaint.findUniqueOrThrow({ where: { id } });
    expect(stored.appealOutcome).toBe(winner.value.appealOutcome);
  });
});
