import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authedAgent } from "./helpers.js";

// Times shown to customers are Indian times, whatever clock the server runs.
//
// "en-IN" sets how a time is written, not which zone it is in. Railway runs on
// UTC, so a ride scheduled for 10 pm was announced as "scheduled for 4:30 pm"
// in the chat. The suite normally runs on an Indian machine, which hid it; it
// runs here as the production server does.

let savedTz: string | undefined;
beforeEach(() => {
  savedTz = process.env.TZ;
  process.env.TZ = "UTC";
});
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("times shown on a UTC server", () => {
  it("announces a scheduled ride at the Indian time the rider asked for", async () => {
    const { agent } = await authedAgent();
    const res = await agent
      .post("/api/chat/message")
      .send({ message: "book a cab to hitec city at 10pm" })
      .expect(200);
    const rec = res.body.message.recommendation;
    expect(rec?.type).toBe("ride");
    expect(rec.scheduledAt).toBeTruthy();
    expect(rec.why).toMatch(/10:00\s?pm/i);
    expect(rec.why).not.toMatch(/4:30\s?pm/i);
  });

  it("formats with the Indian zone directly", async () => {
    const { istTimeLabel, istDateLabel } = await import("../src/lib/istTime.js");
    // 16:30 UTC is 10 pm in India; 20:00 UTC on the 31st is already the 1st there.
    expect(istTimeLabel(new Date("2026-10-07T16:30:00Z"))).toMatch(/10:00\s?pm/i);
    expect(istDateLabel(new Date("2026-10-31T20:00:00Z"), { day: "numeric", month: "short" })).toMatch(/^1 Nov/);
  });
});

describe("calendar months on a UTC server", () => {
  it("counts the month in India", async () => {
    const { istYearMonth } = await import("../src/lib/istTime.js");
    // 20:00 UTC on 31 October is already 1 November in India.
    expect(istYearMonth(new Date("2026-10-31T20:00:00Z"))).toEqual({ year: 2026, month: 10 });
  });
});
