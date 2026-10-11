import { describe, expect, it } from "vitest";
import { consoleAgent } from "./helpers.js";

// Page numbers arrive in a URL, so they are whatever somebody typed. They were
// read with `Number(...) || 1`, which answers Infinity for "1e400" and 1.5 for
// "1.5", and both went straight into a database query:
//
//   ?page=1e400  →  500, and off production the body carried the failing query
//                   and the server's own source path with it
//   ?page=1.5    →  200 with an empty list, having skipped a fraction of a row
//   ?limit=-5    →  200 with the OLDEST audit rows, from a negative take
//
// Written as the attack: a signed-in operator poking at the query string.

describe("console pagination refuses nonsense without failing", () => {
  it("does not answer 500 to an absurd page number", async () => {
    const { agent } = await consoleAgent("super_admin");
    for (const path of [
      "/api/console/admin/users",
      "/api/console/admin/orders",
      "/api/console/admin/tickets",
      "/api/console/super/audit",
    ]) {
      const res = await agent.get(`${path}?page=1e400`);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("Prisma");
    }
  });

  it("treats a fractional page as the first page rather than an empty one", async () => {
    const { agent } = await consoleAgent("super_admin");
    const whole = await agent.get("/api/console/admin/users?page=1").expect(200);
    const fraction = await agent.get("/api/console/admin/users?page=1.5").expect(200);
    expect(fraction.body.page).toBe(1);
    expect(fraction.body.users).toHaveLength(whole.body.users.length);
    expect(whole.body.users.length).toBeGreaterThan(0);
  });

  it("does not let a negative limit read the audit trail backwards", async () => {
    const { agent } = await consoleAgent("developer");
    // More audited actions than the negative limit, so "the newest" and "the
    // oldest" are different answers and reading backwards is visible.
    for (let i = 0; i < 7; i++) {
      await agent
        .patch(`/api/console/dev/flags/pagination-probe-${i}`)
        .send({ enabled: true })
        .expect(200);
    }

    const res = await agent.get("/api/console/dev/audit?limit=-5").expect(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
    expect(res.body.logs.length).toBeGreaterThan(0);
    // The audit trail is newest-first. A negative take reads from the other
    // end, so the latest action went missing from the top of the page.
    expect(res.body.logs[0].targetId).toBe("pagination-probe-6");
  });

  it("still honours a sensible page and limit", async () => {
    const { agent } = await consoleAgent("super_admin");
    const page2 = await agent.get("/api/console/admin/users?page=2").expect(200);
    expect(page2.body.page).toBe(2);
    const dev = await consoleAgent("developer");
    const capped = await dev.agent.get("/api/console/dev/audit?limit=1").expect(200);
    expect(capped.body.logs.length).toBeLessThanOrEqual(1);
  });
});
