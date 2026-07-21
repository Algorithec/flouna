import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authedAgent } from "./helpers.js";

// Settings → notification preferences. Both flags default on, persist per
// user, and reject empty/invalid updates.

describe("user preferences", () => {
  it("defaults both preferences to true", async () => {
    const { agent } = await authedAgent();
    const res = await agent.get("/api/users/preferences").expect(200);
    expect(res.body).toEqual({ emailUpdates: true, smartSuggestions: true });
  });

  it("persists a partial update and leaves the other flag untouched", async () => {
    const { agent } = await authedAgent();
    const put = await agent
      .put("/api/users/preferences")
      .send({ emailUpdates: false })
      .expect(200);
    expect(put.body).toEqual({ emailUpdates: false, smartSuggestions: true });

    const res = await agent.get("/api/users/preferences").expect(200);
    expect(res.body).toEqual({ emailUpdates: false, smartSuggestions: true });
  });

  it("updates both flags together", async () => {
    const { agent } = await authedAgent();
    const put = await agent
      .put("/api/users/preferences")
      .send({ emailUpdates: false, smartSuggestions: false })
      .expect(200);
    expect(put.body).toEqual({ emailUpdates: false, smartSuggestions: false });
  });

  it("rejects an empty update", async () => {
    const { agent } = await authedAgent();
    await agent.put("/api/users/preferences").send({}).expect(400);
  });

  it("rejects non-boolean values", async () => {
    const { agent } = await authedAgent();
    await agent
      .put("/api/users/preferences")
      .send({ emailUpdates: "yes" })
      .expect(400);
  });

  it("is per-user: one user's opt-out does not affect another", async () => {
    const { agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await a.put("/api/users/preferences").send({ smartSuggestions: false }).expect(200);
    const res = await b.get("/api/users/preferences").expect(200);
    expect(res.body.smartSuggestions).toBe(true);
  });

  it("requires auth", async () => {
    await request(app).get("/api/users/preferences").expect(401);
  });
});

describe("addresses (edit screen)", () => {
  it("creates with receiver contact + landmark and edits via PATCH", async () => {
    const { agent } = await authedAgent();
    const created = await agent
      .post("/api/users/addresses")
      .send({
        label: "Home",
        line1: "Flat 402",
        line2: "Sunrise Apartments, MG Road",
        landmark: "Near metro",
        contactName: "Ravi Kumar",
        contactPhone: "9876543210",
        city: "Hyderabad",
        state: "Telangana",
        pincode: "500081",
        lat: 17.44,
        lng: 78.35,
        isDefault: true,
      })
      .expect(201);
    const id = created.body.address.id as string;
    expect(created.body.address.contactName).toBe("Ravi Kumar");

    const updated = await agent
      .patch(`/api/users/addresses/${id}`)
      .send({
        label: "Work",
        line1: "Flat 402",
        line2: "RMZ Infinity",
        city: "Hyderabad",
        state: "Telangana",
        pincode: "500032",
      })
      .expect(200);
    expect(updated.body.address.label).toBe("Work");
    expect(updated.body.address.line2).toBe("RMZ Infinity");
    expect(updated.body.address.landmark).toBeNull(); // full replace semantics
  });

  it("rejects a bad receiver phone and editing someone else's address", async () => {
    const { agent } = await authedAgent();
    await agent
      .post("/api/users/addresses")
      .send({
        label: "Home",
        line1: "1",
        city: "Hyd",
        state: "TG",
        pincode: "500001",
        contactPhone: "12345",
      })
      .expect(400);

    const owner = await authedAgent();
    const created = await owner.agent
      .post("/api/users/addresses")
      .send({ label: "Home", line1: "1A", city: "Hyd", state: "TG", pincode: "500001" })
      .expect(201);
    await agent
      .patch(`/api/users/addresses/${created.body.address.id}`)
      .send({ label: "Hacked", line1: "x", city: "Hyd", state: "TG", pincode: "500001" })
      .expect(404);
  });
});
