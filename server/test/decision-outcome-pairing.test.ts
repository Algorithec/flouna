import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";

// The decision log used to answer "what did Flouna recommend" and stop there.
// A ranker learns from the gap between the option offered and the option
// taken, so without the second half there is no training signal at all and the
// weights can only ever be hand-set guesses.
//
// These tests are about that pairing existing and being trustworthy, not about
// the ranking itself.

/**
 * Both writes are deliberately fire-and-forget so a logging fault can never
 * fail a search or an order, which means the row lands just after the response
 * does. Poll rather than sleep a fixed amount: fast when it is quick, and not
 * flaky when the machine is busy.
 */
async function waitForRow<T>(read: () => Promise<T | null>, timeoutMs = 3000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await read();
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe("decision to outcome pairing", () => {
  it("a food search hands back the id of the ranking it just recorded", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get("/api/food/recommend?q=biryani").expect(200);

    expect(res.body.decisionId).toEqual(expect.any(String));

    const log = await waitForRow(() =>
      prisma.decisionLog.findUnique({ where: { id: res.body.decisionId } }),
    );
    expect(log).not.toBeNull();
    expect(log?.domain).toBe("food");
    // Nothing has been chosen yet, and that is a real state rather than a gap.
    expect(log?.selectedKey).toBeNull();
    expect(log?.orderId).toBeNull();
  });

  it("ordering the recommendation records what was actually chosen", async () => {
    const { agent } = await authedAgent();
    const rec = await agent.get("/api/food/recommend?q=biryani").expect(200);
    const decisionId = rec.body.decisionId as string;

    const order = await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "dum-biryani", platform: "ondc", decisionId })
      .expect(201);

    const paired = await waitForRow(async () => {
      const row = await prisma.decisionLog.findUnique({ where: { id: decisionId } });
      return row?.selectedKey ? row : null;
    });

    expect(paired?.selectedKey).toBe("dum-biryani@ondc");
    expect(paired?.orderId).toBe(order.body.order.id);
    expect(paired?.selectedAt).toBeInstanceOf(Date);
  });

  it("the chosen option is read from the order, not taken from the caller", async () => {
    const { agent } = await authedAgent();
    const rec = await agent.get("/api/food/recommend?q=biryani").expect(200);
    const decisionId = rec.body.decisionId as string;

    // A caller trying to plant a different option in the training data. The
    // key is derived from the order being created, so the claim is ignored.
    await agent
      .post("/api/orders")
      .send({
        domain: "food",
        dishId: "dum-biryani",
        platform: "ondc",
        decisionId,
        selectedKey: "something-else@swiggy",
      })
      .expect(201);

    const paired = await waitForRow(async () => {
      const row = await prisma.decisionLog.findUnique({ where: { id: decisionId } });
      return row?.selectedKey ? row : null;
    });
    expect(paired?.selectedKey).toBe("dum-biryani@ondc");
  });

  it("an unknown or stale decision id never fails the order", async () => {
    const { agent } = await authedAgent();
    // Pruned, or quoted from an earlier session. The order is still good.
    await agent
      .post("/api/orders")
      .send({
        domain: "food",
        dishId: "dum-biryani",
        platform: "ondc",
        decisionId: "00000000-0000-4000-8000-000000000000",
      })
      .expect(201);
  });

  it("an order placed without a decision id is still accepted", async () => {
    const { agent } = await authedAgent();
    await agent
      .post("/api/orders")
      .send({ domain: "food", dishId: "dum-biryani", platform: "ondc" })
      .expect(201);
  });

  it("a search nobody orders from stays unpaired, which is itself the signal", async () => {
    const { agent } = await authedAgent();
    const rec = await agent.get("/api/food/recommend?q=pizza").expect(200);

    const log = await waitForRow(() =>
      prisma.decisionLog.findUnique({ where: { id: rec.body.decisionId } }),
    );
    expect(log?.selectedKey).toBeNull();
    expect(log?.selectedAt).toBeNull();
  });
});

// The race, forced rather than hoped for.
//
// The earlier version fired inserts and selections together and checked they
// all paired. As review pointed out, the database could simply finish every
// insert first, so the test passed without the retry ever running. This one
// fixes the order: the selection goes first, an attempt is shown to find no
// row, and only then is the decision written. It can only pass if the retry
// carries the pairing across that gap.
const USER = "user-pairing-test";
const writeDecision = (id: string, userId: string | null = USER) =>
  prisma.decisionLog.create({
    data: {
      id,
      userId,
      domain: "food",
      query: "race",
      priority: "balanced",
      weights: "{}",
      candidateCount: 1,
      excludedCount: 0,
      results: "[]",
      chosenKey: "a",
    },
  });

describe("pairing across the write race", () => {
  it("pairs when the selection arrives before the decision is written", async () => {
    const { recordSelection } = await import("../src/modules/advisor/decisionLog.service.js");
    const id = randomUUID();

    const outcome = recordSelection({ decisionId: id, selectedKey: "chosen", orderId: "o-race", userId: USER });

    // Its first attempt has run and found nothing: the row does not exist.
    await new Promise((r) => setTimeout(r, 60));
    expect(await prisma.decisionLog.findUnique({ where: { id } })).toBeNull();

    await writeDecision(id);

    expect(await outcome).toBe("paired");
    const row = await prisma.decisionLog.findUnique({ where: { id } });
    expect(row?.selectedKey).toBe("chosen");
    expect(row?.orderId).toBe("o-race");
    await prisma.decisionLog.deleteMany({ where: { id } });
  });
});

// A decision pairs only with an order from the customer it was made for.
//
// Raised in review. Without the check any valid decision id could be quoted on
// an unrelated order and recorded as that customer's choice, and this record
// is training data.
describe("pairing belongs to one customer", () => {
  it("pairs a customer's own decision", async () => {
    const { recordSelection } = await import("../src/modules/advisor/decisionLog.service.js");
    const id = randomUUID();
    await writeDecision(id);
    expect(await recordSelection({ decisionId: id, selectedKey: "k", orderId: "o1", userId: USER })).toBe("paired");
    await prisma.decisionLog.deleteMany({ where: { id } });
  });

  it("refuses another customer's decision, at once and without changing it", async () => {
    const { recordSelection } = await import("../src/modules/advisor/decisionLog.service.js");
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = randomUUID();
    await writeDecision(id, "someone-else");

    const started = Date.now();
    expect(await recordSelection({ decisionId: id, selectedKey: "k", orderId: "o2", userId: USER })).toBe("not_owned");
    // Refused on the first look, not after the whole retry window.
    expect(Date.now() - started).toBeLessThan(1000);
    const row = await prisma.decisionLog.findUnique({ where: { id } });
    expect(row?.selectedKey).toBeNull();
    expect(row?.orderId).toBeNull();
    warn.mockRestore();
    await prisma.decisionLog.deleteMany({ where: { id } });
  });

  it("refuses when no customer is given, rather than matching on the id alone", async () => {
    // Prisma drops a filter set to undefined, so a missing user must not reach
    // the query at all.
    const { recordSelection } = await import("../src/modules/advisor/decisionLog.service.js");
    const id = randomUUID();
    await writeDecision(id);
    const outcome = await recordSelection({
      decisionId: id,
      selectedKey: "k",
      orderId: "o3",
      userId: undefined as unknown as string,
    });
    expect(outcome).toBe("not_owned");
    expect((await prisma.decisionLog.findUnique({ where: { id } }))?.selectedKey).toBeNull();
    await prisma.decisionLog.deleteMany({ where: { id } });
  });
});

// Transient database faults do not abandon a pairing.
//
// Retrying only "record not found" was not enough. Under load the update also
// failed with a socket timeout while waiting for a lock, an error with no code,
// which was treated as permanent: the row existed, no insert had failed, and 3
// or 4 of 25 pairings were still dropped on the first attempt. That is what
// made the pairing test fail now and then in the full suite, and widening the
// retry window changed nothing, because that path never reached it.
//
// The decision that was wrong is whether an error is worth retrying, so that
// is what is tested here, directly. The loop that acts on it was proven under
// contention from 20 to 120 competing writers, pairing 25 of 25 every run.
describe("which faults a pairing waits out", () => {
  it.each([
    ["the row not written yet", Object.assign(new Error("No record was found for an update."), { code: "P2025" })],
    ["a socket timeout, which carries no code", new Error("Invalid `prisma.decisionLog.update()` invocation: Socket timeout (the database failed to respond to a query within the configured timeout)")],
    ["a pool timeout", Object.assign(new Error("Timed out fetching a new connection from the connection pool"), { code: "P2024" })],
    ["a write conflict", Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), { code: "P2034" })],
    ["an unreachable database", Object.assign(new Error("Can't reach database server"), { code: "P1001" })],
    ["SQLite being locked", new Error("database is locked")],
  ])("retries %s", async (_, err) => {
    const { isTransient } = await import("../src/modules/advisor/decisionLog.service.js");
    expect(isTransient(err)).toBe(true);
  });

  it.each([
    ["a validation error", Object.assign(new Error("Argument selectedKey is invalid"), { name: "PrismaClientValidationError" })],
    ["a unique constraint", Object.assign(new Error("Unique constraint failed"), { code: "P2002" })],
    ["a plain failure with nothing transient about it", new Error("Something is wrong with this data")],
  ])("does not retry %s, which waiting cannot fix", async (_, err) => {
    const { isTransient } = await import("../src/modules/advisor/decisionLog.service.js");
    expect(isTransient(err)).toBe(false);
  });

  it("never retries a validation error, even if its message mentions a timeout", async () => {
    // The class decides first. A message is only a fallback for errors that
    // carry no code, and must not turn bad data into something retried.
    const { isTransient } = await import("../src/modules/advisor/decisionLog.service.js");
    const err = Object.assign(new Error("invalid value for timeout field"), { name: "PrismaClientValidationError" });
    expect(isTransient(err)).toBe(false);
  });
});
