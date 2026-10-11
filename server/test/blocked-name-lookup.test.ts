import { describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

// Blocking somebody takes their email address and answered with their display
// name and avatar. Anybody could therefore turn an address they already had
// into the name of the person behind it, for any account on the platform, and
// unblock afterwards to leave no trace.
//
// It also contradicted the one setting that says otherwise: a member whose
// profile is set to "nobody" is told their name is not shown to other people,
// and the cart screens honour that. This route named them.

describe("blocking by email does not name the account", () => {
  it("withholds the name of someone whose profile is hidden", async () => {
    const me = await authedAgent({ withAddress: false });
    const them = await authedAgent({ withAddress: false });
    await prisma.user.update({
      where: { email: them.email },
      data: { name: "Anita Rao", profileVisibility: "nobody", avatarUrl: "/a.png" },
    });

    const res = await me.agent
      .post("/api/users/blocked")
      .send({ email: them.email })
      .expect(201);
    expect(res.body.blocked.user.name).not.toBe("Anita Rao");
    expect(res.body.blocked.user.avatarUrl).toBeNull();

    // And not one request later, either.
    const list = await me.agent.get("/api/users/blocked").expect(200);
    expect(JSON.stringify(list.body)).not.toContain("Anita Rao");
  });

  it("still names someone whose profile is open, so the screen is useful", async () => {
    const me = await authedAgent({ withAddress: false });
    const them = await authedAgent({ withAddress: false });
    await prisma.user.update({
      where: { email: them.email },
      data: { name: "Open Person", profileVisibility: "everyone" },
    });

    const res = await me.agent
      .post("/api/users/blocked")
      .send({ email: them.email })
      .expect(201);
    expect(res.body.blocked.user.name).toBe("Open Person");

    const list = await me.agent.get("/api/users/blocked").expect(200);
    expect(list.body.blocked[0].user.name).toBe("Open Person");
  });

  it("still refuses an address with no account", async () => {
    const me = await authedAgent({ withAddress: false });
    await me.agent
      .post("/api/users/blocked")
      .send({ email: "nobody-at-all@test.dev" })
      .expect(404);
  });
});
