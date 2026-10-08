import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Failed logins have to be counted, including the ones that arrive together.
//
// The count was read with the user and written back as that value plus one,
// so wrong passwords sent at the same moment all wrote the same number: a
// burst of guesses counted as one, and the account lock that exists to stop
// distributed password grinding never engaged.

describe("counting failed logins", () => {
  it("counts every wrong password in a burst and locks the account", async () => {
    const { email } = await authedAgent();

    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post("/api/auth/login").send({ email, password: "wrong-password-1" }),
      ),
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLogins).toBe(10);
    expect(user.lockedUntil).not.toBeNull();
  });

  it("refuses the right password while the account is locked", async () => {
    const { email } = await authedAgent();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post("/api/auth/login").send({ email, password: "wrong-password-1" }),
      ),
    );
    await request(app).post("/api/auth/login").send({ email, password: "password123" }).expect(429);
  });

  it("still lets a customer in after a single typo", async () => {
    const { email } = await authedAgent();
    await request(app).post("/api/auth/login").send({ email, password: "typo" }).expect(401);
    await request(app).post("/api/auth/login").send({ email, password: "password123" }).expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLogins).toBe(0);
  });
});

describe("counting failed logins at the operator console", () => {
  it("counts a burst of wrong passwords there too", async () => {
    // The back office has its own login, and it had the same fault.
    const { email } = await authedAgent();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post("/api/auth/console/login").send({ email, password: "wrong-password-1" }),
      ),
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLogins).toBe(10);
    expect(user.lockedUntil).not.toBeNull();
  });
});
