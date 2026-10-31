import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { csvCell, toCsv } from "../src/lib/csv.js";
import { adminTrends } from "../src/modules/backoffice/reporting.service.js";
import { authedAgent, consoleAgent } from "./helpers.js";

// The admin console's reports: trends by the Indian day, savings counted on
// paid orders only, the city filters, the exports and the health panel. Each
// is something a founder reads and acts on, so each is checked as a number.

let seq = 0;
async function userAt(createdAt: Date) {
  seq += 1;
  return prisma.user.create({ data: { email: `trend-${Date.now()}-${seq}@example.com`, name: "Trend", createdAt } });
}

async function orderAt(userId: string, createdAt: Date, o: { status?: string; fulfillment?: string; savedPaise?: number } = {}) {
  return prisma.order.create({
    data: {
      userId,
      domain: "food",
      status: o.status ?? "completed",
      provider: o.fulfillment === "redirect" ? "swiggy" : "ondc",
      fulfillment: o.fulfillment ?? "in_app",
      title: "Trend order",
      details: "{}",
      amount: 25_000,
      savedPaise: o.savedPaise ?? 0,
      createdAt,
    },
  });
}

describe("dashboard trends", () => {
  // A window years before anything else in the test database, so the counts
  // here are only what this test made.
  const now = new Date("2020-03-10T12:00:00Z");

  it("buckets by the Indian day, counts paid orders only, and leaves an orderless day without a share", async () => {
    const before = await userAt(new Date("2020-01-15T10:00:00Z"));
    const u = await userAt(new Date("2020-03-09T20:00:00Z")); // 10 Mar, 1:30 am in India
    // 1:30 am on 10 Mar in India, which is still 9 Mar in UTC.
    await orderAt(u.id, new Date("2020-03-09T20:00:00Z"), { fulfillment: "in_app", savedPaise: 4_000 });
    await orderAt(u.id, new Date("2020-03-10T06:00:00Z"), { fulfillment: "redirect", savedPaise: 1_000 });
    // Abandoned at payment and cancelled: neither is an order, nor a saving.
    await orderAt(u.id, new Date("2020-03-10T07:00:00Z"), { status: "pending_payment", savedPaise: 90_000 });
    await orderAt(u.id, new Date("2020-03-10T08:00:00Z"), { status: "cancelled", savedPaise: 90_000 });

    const t = await adminTrends(30, now);
    expect(t.series).toHaveLength(30);
    expect(t.series[29]!.date).toBe("2020-03-10");
    expect(t.series[0]!.date).toBe("2020-02-10");
    const today = t.series[29]!;
    expect(today).toMatchObject({ signups: 1, orders: 2, ondcOrders: 1, ondcSharePct: 50, savedPaise: 5_000 });
    expect(t.series[28]).toMatchObject({ date: "2020-03-09", orders: 0, ondcSharePct: null, savedPaise: 0 });
    expect(t.totals).toMatchObject({ signups: 1, orders: 2, ondcOrders: 1, ondcSharePct: 50, savedPaise: 5_000 });
    // Accounts at the end of each day: the earlier one throughout, then both.
    expect(t.totals.usersAtStart).toBeGreaterThanOrEqual(1);
    expect(t.series[28]!.users).toBe(t.totals.usersAtStart);
    expect(today.users).toBe(t.totals.usersAtStart + 1);
    expect(t.totals.usersNow).toBe(today.users);

    await prisma.user.deleteMany({ where: { id: { in: [before.id, u.id] } } });
  });

  it("answers the route with the days asked for, and 30 for anything unusable", async () => {
    const { agent } = await consoleAgent("admin");
    expect((await agent.get("/api/console/admin/reports/trends?days=7").expect(200)).body.series).toHaveLength(7);
    for (const bad of ["1e400", "2.5", "-3", "abc", "1000"]) {
      expect((await agent.get(`/api/console/admin/reports/trends?days=${bad}`).expect(200)).body.days, bad).toBe(30);
    }
  });
});

describe("savings on the console", () => {
  it("are counted on paid orders only, as the customer's own Savings screen counts them", async () => {
    const { agent } = await consoleAgent("admin");
    const read = async () => {
      const dash = (await agent.get("/api/console/admin/dashboard").expect(200)).body.userSavedPaise as number;
      const analytics = (await agent.get("/api/console/admin/analytics").expect(200)).body.userSavedPaise as number;
      return { dash, analytics };
    };
    const start = await read();
    const u = await userAt(new Date());
    await orderAt(u.id, new Date(), { status: "pending_payment", savedPaise: 77_700 });
    await orderAt(u.id, new Date(), { status: "cancelled", savedPaise: 77_700 });
    expect(await read()).toEqual(start);
    await orderAt(u.id, new Date(), { status: "completed", savedPaise: 1_200 });
    expect(await read()).toEqual({ dash: start.dash + 1_200, analytics: start.analytics + 1_200 });
    const detail = (await agent.get(`/api/console/admin/users/${u.id}`).expect(200)).body;
    expect(JSON.stringify(detail)).toContain("1200");
    expect(JSON.stringify(detail)).not.toContain("156600");
    await prisma.user.delete({ where: { id: u.id } });
  });
});

describe("the city report", () => {
  it("filters by state and tier and sorts, while still listing every state and tier to choose from", async () => {
    const { agent } = await consoleAgent("admin");
    const all = (await agent.get("/api/console/admin/cities").expect(200)).body;
    expect(all.rows.length).toBe(all.citiesActive);
    expect(all.states).toContain("Maharashtra");
    expect(all.tiers).toEqual(["Tier 1", "Tier 2"]);

    const mh = (await agent.get("/api/console/admin/cities?state=Maharashtra&sort=city").expect(200)).body;
    expect(mh.rows.map((r: { city: string }) => r.city)).toEqual(["Mumbai", "Pune"]);
    expect(mh.rows.map((r: { rank: number }) => r.rank)).toEqual([1, 2]);
    expect(mh.states).toEqual(all.states);

    const tier2 = (await agent.get("/api/console/admin/cities?tier=Tier%202").expect(200)).body;
    expect(tier2.rows.every((r: { tier: string }) => r.tier === "Tier 2")).toBe(true);
    expect(tier2.rows.length).toBeGreaterThan(0);

    const byName = (await agent.get("/api/console/admin/cities?sort=city").expect(200)).body.rows.map((r: { city: string }) => r.city);
    expect(byName).toEqual([...byName].sort((a: string, b: string) => a.localeCompare(b)));

    // An unknown sort falls back to orders, and an unknown state is no rows, not an error.
    const odd = (await agent.get("/api/console/admin/cities?sort=drop%20table").expect(200)).body;
    expect(odd.rows.map((r: { city: string }) => r.city)).toEqual(all.rows.map((r: { city: string }) => r.city));
    expect((await agent.get("/api/console/admin/cities?state=Atlantis").expect(200)).body.rows).toEqual([]);
  });
});

describe("report exports", () => {
  it("send a CSV of the rows the page shows, uncached and audited", async () => {
    const { agent } = await consoleAgent("admin");
    const res = await agent.get("/api/console/admin/reports/cities.csv?state=Maharashtra&sort=city").expect(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="cities.csv"`);
    const lines = res.text.replace(/^﻿/, "").trim().split("\n");
    expect(res.text.startsWith("﻿")).toBe(true); // Excel reads it as UTF-8
    expect(lines[0]).toBe("Rank,City,State,Tier,Orders,GMV (INR),Saved (INR),Coverage");
    expect(lines.slice(1).map((l) => l.split(",")[1])).toEqual(["Mumbai", "Pune"]);
    const audit = await prisma.auditLog.findFirst({ where: { action: "export.cities" }, orderBy: { createdAt: "desc" } });
    expect(audit).not.toBeNull();

    for (const name of ["dashboard", "analytics", "vendors", "trends"]) {
      const r = await agent.get(`/api/console/admin/reports/${name}.csv`).expect(200);
      expect(r.headers["cache-control"], name).toBe("no-store");
      expect(r.text.replace(/^﻿/, "").split("\n")[0]!.length, name).toBeGreaterThan(0);
    }
  });

  it("are refused to customers and to staff outside operations", async () => {
    const customer = await authedAgent();
    const developer = await consoleAgent("developer");
    for (const path of ["/api/console/admin/reports/cities.csv", "/api/console/admin/reports/trends", "/api/console/admin/system-health"]) {
      // Neither is told the route is there at all, as for every console route.
      expect((await customer.agent.get(path)).status, path).toBe(404);
      expect((await developer.agent.get(path)).status, path).toBe(404);
    }
  });

  it("keep spreadsheet formulas from running, and numbers as numbers", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+91 98")).toBe("'+91 98");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell("a,b")).toBe("\"a,b\"");
    expect(toCsv(["A", "B"], [[1, "x\ny"]])).toBe("A,B\n1,\"x\ny\"\n");
  });
});

describe("the system health panel", () => {
  it("says what is on without giving away any key", async () => {
    const { agent } = await consoleAgent("admin");
    const body = (await agent.get("/api/console/admin/system-health").expect(200)).body;
    expect(body.database.ok).toBe(true);
    expect(typeof body.database.latencyMs).toBe("number");
    expect(body.alerts).toMatchObject({ critical: expect.any(Number), warning: expect.any(Number) });
    const names = body.services.map((s: { name: string }) => s.name);
    expect(names).toEqual(expect.arrayContaining(["Payments", "Email codes", "ONDC network", "Chat engine"]));
    for (const s of body.services) expect(["on", "off", "sandbox", "simulated"]).toContain(s.state);
    const text = JSON.stringify(body);
    for (const secret of [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.CASHFREE_SECRET_KEY, env.BREVO_API_KEY, env.VAPID_PRIVATE_KEY]) {
      if (secret) expect(text).not.toContain(secret);
    }
  });
});
