import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authedAgent, lastOtpFor } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Suspending a customer has to stop them using the product.
//
// It did not. suspendedAt was read in exactly two places: requireRole, which
// only an operator ever reaches, and /refresh. So an account suspended from the
// admin console could sign in again as if nothing had happened, and the fresh
// fifteen minute access token was all it needed to keep ordering — the refresh
// that would have cut it off never had to happen, because logging in again
// handed out another one. The suspend button in the console, the audit entry
// behind it and the row it wrote were all real; the only thing that was not was
// the consequence.
//
// Every session now comes through one door, so these cover the password login,
// the two-factor second step, and what an already-open session can still do.

describe("a suspended account", () => {
  it("cannot sign in with the right password", async () => {
    const { email } = await authedAgent();
    await prisma.user.update({ where: { email }, data: { suspendedAt: new Date() } });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "password123" });

    expect(res.status).toBe(403);
    // And no session came with the refusal.
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("cannot sign in through the two-factor second step either", async () => {
    const { agent, email } = await authedAgent();
    await agent.post("/api/users/two-factor/start").expect(200);
    await agent
      .post("/api/users/two-factor/confirm")
      .send({ code: lastOtpFor(email) })
      .expect(200);

    const fresh = request.agent(app);
    const first = await fresh.post("/api/auth/login").send({ email, password: "password123" });
    expect(first.body.next).toBe("two-factor");

    // Suspended between the password and the code, which is the window an
    // operator suspending a live account is actually in.
    await prisma.user.update({ where: { email }, data: { suspendedAt: new Date() } });

    const res = await fresh
      .post("/api/auth/login/verify")
      .send({ email, code: lastOtpFor(email) });
    expect(res.status).toBe(403);
  });

  it("loses the session it already had at the next refresh", async () => {
    const { agent, email } = await authedAgent();
    await agent.get("/api/auth/me").expect(200);
    await prisma.user.update({ where: { email }, data: { suspendedAt: new Date() } });

    await agent.post("/api/auth/refresh").expect(403);
  });

  it("works again once it is reinstated", async () => {
    const { email } = await authedAgent();
    await prisma.user.update({ where: { email }, data: { suspendedAt: new Date() } });
    await request(app).post("/api/auth/login").send({ email, password: "password123" }).expect(403);

    await prisma.user.update({ where: { email }, data: { suspendedAt: null } });
    await request(app).post("/api/auth/login").send({ email, password: "password123" }).expect(200);
  });
});
