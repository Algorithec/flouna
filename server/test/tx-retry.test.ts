import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { isRetryableTxError, withTxRetry } from "../src/lib/txRetry.js";
import { ApiError } from "../src/middleware/error.js";
import { prisma } from "../src/lib/prisma.js";
import { authedAgent } from "./helpers.js";
import { spendFromWallet } from "../src/modules/users/wallet.service.js";

// Retrying a transaction the database gave up on.
//
// Found by CI, whose disk is slower than a laptop's: under contention the
// database answered "socket timeout" (P1008) or let the transaction expire
// (P2028) rather than "could not serialize" (P2034). Only the last was
// retried, so a customer spending reward credit or claiming a code while
// others did the same got a server error, though nothing had been written and
// running it again was safe.

afterEach(() => vi.restoreAllMocks());

const known = (code: string, message = code) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test" });

describe("what is safe to run again", () => {
  it.each([
    ["a serialization failure", known("P2034")],
    ["a socket timeout", known("P1008", "Socket timeout (the database failed to respond)")],
    ["an expired transaction", known("P2028", "Transaction API error: Transaction not found.")],
    ["a busy SQLite file", new Error("database is locked")],
  ])("retries %s", (_, err) => {
    expect(isRetryableTxError(err)).toBe(true);
  });

  it.each([
    ["a unique constraint", known("P2002")],
    ["a refusal meant for the customer", new ApiError(409, "This code has been fully claimed")],
    ["a plain bug", new TypeError("x is undefined")],
  ])("does not retry %s", (_, err) => {
    expect(isRetryableTxError(err)).toBe(false);
  });
});

describe("withTxRetry", () => {
  it("runs again after a timeout and returns the answer", async () => {
    let calls = 0;
    const out = await withTxRetry(async () => {
      if (++calls < 3) throw known("P1008");
      return "done";
    });
    expect(out).toBe("done");
    expect(calls).toBe(3);
  });

  it("gives up after its attempts, with the last error", async () => {
    let calls = 0;
    await expect(
      withTxRetry(async () => {
        calls++;
        throw known("P2034");
      }, { attempts: 4 }),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(calls).toBe(4);
  });

  it("does not repeat a refusal", async () => {
    let calls = 0;
    await expect(
      withTxRetry(async () => {
        calls++;
        throw new ApiError(400, "You've already used this code");
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });
});

describe("spending reward credit while the database is busy", () => {
  it("succeeds after the database times out once", async () => {
    const { email } = await authedAgent();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.walletEntry.create({
      data: { userId: user.id, amountPaise: 5000, reason: "cashback", description: "test credit" },
    });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        domain: "food",
        status: "pending_payment",
        provider: "ondc",
        fulfillment: "in_app",
        title: "Busy database",
        details: "{}",
        amount: 30000,
      },
    });

    const real = prisma.$transaction.bind(prisma);
    let first = true;
    vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => {
      if (first) {
        first = false;
        return Promise.reject(known("P1008", "Socket timeout"));
      }
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);

    const took = await spendFromWallet({ userId: user.id, orderId: order.id, maxPaise: 30000 });
    expect(took).toBe(5000);
  });
});
