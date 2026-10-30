import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { systemAlerts } from "../src/modules/backoffice/systemStatus.service.js";
import { ordersWaitingOnSeller } from "../src/modules/ondc/waiting.js";
import { authedAgent, consoleAgent } from "./helpers.js";

// ONDC orders a seller acknowledged and never answered. A paid one holds the
// customer's money with no order placed, so it is raised as critical; the
// rest are listed for the console. Nothing here moves money.

let userId: string | undefined;
async function user() {
  if (!userId) {
    const a = await authedAgent();
    userId = (await prisma.user.findUniqueOrThrow({ where: { email: a.email } })).id;
  }
  return userId;
}

async function order(o: { status: string; awaiting?: boolean; paid?: boolean; minutesAgo: number }) {
  const row = await prisma.ondcOrder.create({
    data: {
      userId: await user(),
      txnId: crypto.randomUUID(),
      status: o.status,
      awaitingMsgId: o.awaiting === false ? null : crypto.randomUUID(),
      bppId: "seller.silent.example",
      bppUri: "https://seller.silent.example/ondc",
      providerId: "p",
      locationId: "l",
      storeName: "Silent Store",
      city: "std:080",
      lines: "[]",
      totalPaise: 47500,
      ...(o.paid ? { paidAt: new Date(), paidPaise: 47500, paymentRef: "cf_pay_1" } : {}),
    },
  });
  // When the step was sent: updatedAt moves on every change to the row.
  await prisma.ondcOrder.update({ where: { id: row.id }, data: { updatedAt: new Date(Date.now() - o.minutesAgo * 60_000) } });
  return row.id;
}

describe("orders waiting on a seller", () => {
  it("lists each step past its own limit, with what the customer paid, longest first", async () => {
    // Made newest first, so the longest wait coming out first is the sort's doing.
    const select = await order({ status: "selecting", minutesAgo: 6 });
    const freshConfirm = await order({ status: "confirming", paid: true, minutesAgo: 8 });
    const paidConfirm = await order({ status: "confirming", paid: true, minutesAgo: 12 });
    const cancelSoon = await order({ status: "cancelling", minutesAgo: 20 });
    const answered = await order({ status: "confirming", awaiting: false, paid: true, minutesAgo: 30 });
    const placed = await order({ status: "placed", minutesAgo: 60 });

    const ours = new Set([paidConfirm, freshConfirm, select, cancelSoon, answered, placed]);
    const waiting = (await ordersWaitingOnSeller()).filter((w) => ours.has(w.id));

    expect(waiting.map((w) => w.id)).toEqual([paidConfirm, select]);
    expect(waiting[0]).toMatchObject({ status: "confirming", store: "Silent Store", paidPaise: 47500 });
    expect(waiting[0]!.waitingMinutes).toBeGreaterThanOrEqual(12);
    expect(waiting[1]).toMatchObject({ status: "selecting", paidPaise: null });
  });

  it("raises a paid order nobody confirmed as critical in the alerts feed", async () => {
    await order({ status: "confirming", paid: true, minutesAgo: 15 });
    const { alerts } = await systemAlerts();
    const critical = alerts.find((a) => a.source === "ondc" && a.severity === "critical");
    expect(critical?.message).toMatch(/paid ONDC orders? (has|have) waited over 10 minutes for the seller to confirm/);
  });

  it("shows them on the ONDC operations page", async () => {
    const id = await order({ status: "confirming", paid: true, minutesAgo: 25 });
    const { agent } = await consoleAgent("developer");
    const body = (await agent.get("/api/console/dev/network").expect(200)).body;
    const row = body.ops.waiting.find((w: { id: string }) => w.id === id);
    expect(row).toMatchObject({ status: "confirming", paidPaise: 47500 });
  });
});
