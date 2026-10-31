import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { csvCell } from "../src/modules/ondc/commission.service.js";
import { authedAgent, consoleAgent } from "./helpers.js";

// Commission on ONDC orders, worked out from the settlement rows. Each case is
// a settlement in a state that money can really be in, checked against what
// we are owed, what reached us, and whether it belongs in the exception queue.

const APP = `seller-${crypto.randomUUID().slice(0, 8)}.example`;
const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);

async function settlement(o: {
  role: "receiver" | "collector";
  status: string;
  fee: number;
  total?: number;
  settled?: number;
  recon?: string;
  dueDaysAgo?: number;
  createdDaysAgo?: number;
  bppId?: string;
}) {
  const total = o.total ?? 50000;
  const due = o.role === "receiver" ? o.fee : total - o.fee;
  return prisma.ondcSettlement.create({
    data: {
      ondcOrderId: crypto.randomUUID(),
      bppId: o.bppId ?? APP,
      networkOrderId: `net-${crypto.randomUUID().slice(0, 8)}`,
      role: o.role,
      orderTotalPaise: total,
      feePaise: o.fee,
      interParticipantPaise: due,
      collectorPaise: o.role === "receiver" ? total - o.fee : o.fee,
      selfPaise: o.fee,
      dueAt: new Date(Date.now() - (o.dueDaysAgo ?? -2) * DAY),
      status: o.status,
      settledPaise: o.settled ?? null,
      settledAt: o.status === "settled" ? new Date() : null,
      reconStatus: o.recon ?? null,
      createdAt: new Date(Date.now() - (o.createdDaysAgo ?? 0) * DAY),
    },
  });
}

describe("ONDC commission", () => {
  it("works out expected, confirmed, received, outstanding and variance for both sides", async () => {
    const app = `seller-${crypto.randomUUID().slice(0, 8)}.example`;
    // The seller collected and paid our 1500 in full; it agreed in reconciliation.
    await settlement({ role: "receiver", status: "settled", fee: 1500, settled: 1500, recon: "accord", bppId: app });
    // The seller collected and paid only 1000 of our 1500.
    await settlement({ role: "receiver", status: "settled", fee: 1500, settled: 1000, bppId: app });
    // Flouna collected 50000 and paid the seller 48600 of the 48500 due: we kept 100 less.
    await settlement({ role: "collector", status: "settled", fee: 1500, settled: 48600, bppId: app });
    // Not settled yet.
    await settlement({ role: "receiver", status: "due", fee: 1500, bppId: app });

    const { agent } = await consoleAgent("admin");
    const report = (await agent.get(`/api/console/admin/ondc/commission?to=${today}`).expect(200)).body;
    const mine = report.bySellerApp.find((a: { bppId: string }) => a.bppId === app);
    expect(mine).toMatchObject({
      orders: 4,
      orderValuePaise: 200000,
      expectedPaise: 6000,
      confirmedPaise: 1500,
      receivedPaise: 1500 + 1000 + 1400,
      outstandingPaise: 0 + 500 + 100 + 1500,
      variancePaise: 0 - 500 + 100,
    });
  });

  it("queues what does not add up, and leaves what does", async () => {
    const ok = await settlement({ role: "receiver", status: "settled", fee: 900, settled: 900 });
    const short = await settlement({ role: "receiver", status: "settled", fee: 900, settled: 700 });
    const disputed = await settlement({ role: "receiver", status: "instructed", fee: 900, recon: "dispute" });
    const failed = await settlement({ role: "receiver", status: "not_settled", fee: 900 });
    const late = await settlement({ role: "receiver", status: "instructed", fee: 900, dueDaysAgo: 3 });
    const notYetLate = await settlement({ role: "receiver", status: "instructed", fee: 900, dueDaysAgo: 0.5 });
    const heldLong = await settlement({ role: "collector", status: "held", fee: 900, createdDaysAgo: 8 });

    const { agent } = await consoleAgent("admin");
    const report = (await agent.get(`/api/console/admin/ondc/commission?from=2026-01-01&to=${today}`).expect(200)).body;
    const reasons = (id: string) =>
      report.exceptions.filter((e: { settlementId: string }) => e.settlementId === id).map((e: { reason: string }) => e.reason);
    expect(reasons(ok.id)).toEqual([]);
    expect(reasons(short.id)).toEqual(["amount_mismatch"]);
    expect(reasons(disputed.id)).toEqual(["dispute"]);
    expect(reasons(failed.id)).toEqual(["failed"]);
    expect(reasons(late.id)).toEqual(["overdue"]);
    expect(reasons(notYetLate.id)).toEqual([]);
    expect(reasons(heldLong.id)).toEqual(["held_too_long"]);
    expect(report.exceptions.find((e: { settlementId: string }) => e.settlementId === short.id)).toMatchObject({ status: "open", variancePaise: -200 });
  });

  it("records a decision on a queued exception, refuses one on a row that adds up, and audits it", async () => {
    const short = await settlement({ role: "receiver", status: "settled", fee: 800, settled: 500 });
    const ok = await settlement({ role: "receiver", status: "settled", fee: 800, settled: 800 });
    const { agent } = await consoleAgent("admin");

    await agent
      .post("/api/console/admin/ondc/commission/exceptions")
      .send({ settlementId: short.id, reason: "amount_mismatch", status: "investigating", note: "asked the seller app" })
      .expect(200);
    await agent
      .post("/api/console/admin/ondc/commission/exceptions")
      .send({ settlementId: ok.id, reason: "amount_mismatch", status: "resolved" })
      .expect(409);
    await agent
      .post("/api/console/admin/ondc/commission/exceptions")
      .send({ settlementId: short.id, reason: "amount_mismatch", status: "resolved", extra: 1 })
      .expect(400);

    const report = (await agent.get(`/api/console/admin/ondc/commission?to=${today}`).expect(200)).body;
    expect(report.exceptions.find((e: { settlementId: string }) => e.settlementId === short.id)).toMatchObject({
      status: "investigating",
      note: "asked the seller app",
    });
    expect(await prisma.auditLog.count({ where: { action: "ondc.settlement_exception", targetId: short.id } })).toBe(1);
  });

  it("refuses a nonsense period rather than guessing", async () => {
    const { agent } = await consoleAgent("admin");
    await agent.get("/api/console/admin/ondc/commission?from=2026-13-40").expect(400);
    await agent.get("/api/console/admin/ondc/commission?from=2026-10-10&to=2026-10-01").expect(400);
  });

  it("exports a CSV Excel cannot run as formulas", async () => {
    await settlement({ role: "receiver", status: "settled", fee: 1200, settled: 1200, bppId: "=HYPERLINK(\"http://evil.example\")" });
    const { agent } = await consoleAgent("admin");
    const res = await agent.get(`/api/console/admin/ondc/commission.csv?to=${today}`).expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text.split("\r\n")[0]).toContain("commission_expected");
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(res.text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(-200)).toBe("-200");
    expect(csvCell("plain")).toBe("plain");
  });

  it("is hidden from customers and developers", async () => {
    const { agent: customer } = await authedAgent();
    await customer.get("/api/console/admin/ondc/commission").expect(404);
    const { agent: developer } = await consoleAgent("developer");
    await developer.get("/api/console/admin/ondc/commission").expect(404);
  });
});
