import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, lastOtpFor, authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Login Activity exists so somebody can read the list of devices on their
// account and spot one they do not recognise. It is built out of the refresh
// tokens, which record a user agent and an address — when the route that
// started the session bothers to pass them.
//
// Four of the six doors did not: email verification at sign-up, both Google
// paths, and the operator console. Those sessions appeared on the screen as an
// unnamed row with nothing in it, which is the row that matters most.

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605";

describe("every session records the device it came from", () => {
  it("names the session created by verifying the sign-up code", async () => {
    const email = `device-${Date.now()}@test.dev`;
    const agent = request.agent(app);
    await agent
      .post("/api/auth/signup")
      .set("User-Agent", UA)
      .send({
        name: "Test User",
        email,
        password: "password123",
        dateOfBirth: "1995-04-12",
        acceptTerms: true,
      })
      .expect(201);
    await agent
      .post("/api/auth/verify-email")
      .set("User-Agent", UA)
      .send({ email, code: lastOtpFor(email) })
      .expect(200);

    const sessions = await agent.get("/api/users/sessions").expect(200);
    expect(sessions.body.sessions).toHaveLength(1);
    expect(sessions.body.sessions[0].userAgent).toBe(UA);
  });

  it("names an operator's console session too", async () => {
    const { agent, email } = await authedAgent({ withAddress: false });
    await prisma.user.update({ where: { email }, data: { role: "admin" } });
    await agent
      .post("/api/auth/console/login")
      .set("User-Agent", UA)
      .send({ email, password: "password123" })
      .expect(200);
    await agent
      .post("/api/auth/console/verify")
      .set("User-Agent", UA)
      .send({ email, code: lastOtpFor(email) })
      .expect(200);

    const sessions = await agent.get("/api/users/sessions").expect(200);
    const named = sessions.body.sessions.filter(
      (s: { userAgent: string | null }) => s.userAgent === UA,
    );
    expect(named.length).toBeGreaterThan(0);
  });
});
