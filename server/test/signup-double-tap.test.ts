import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Signing up with a double tap creates one account and reports no failure.
//
// Both requests looked for the email, found nothing, and tried to create the
// account. The slower one hit the unique email and came back as a 500, so a
// sign up that had worked could end on "something went wrong".

describe("signing up twice at once", () => {
  it("creates one account, and neither request fails", async () => {
    const email = `double-${Date.now()}@test.dev`;
    const body = {
      name: "Test User",
      email,
      password: "password123",
      dateOfBirth: "1995-04-12",
      acceptTerms: true,
    };

    const results = await Promise.all([
      request(app).post("/api/auth/signup").send(body),
      request(app).post("/api/auth/signup").send(body),
    ]);

    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });
});
