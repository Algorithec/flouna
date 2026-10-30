import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import {
  predictFromHistory,
  recordObservation,
} from "../src/modules/advisor/priceHistory.service.js";
import { authedAgent } from "./helpers.js";

// Seed observations directly so we control the learned pattern.
async function seed(
  domain: "food" | "ride",
  key: string,
  hour: number,
  prices: number[],
) {
  await prisma.priceObservation.createMany({
    data: prices.map((bestPaise) => ({
      domain,
      key,
      hour,
      weekday: 0,
      bestPaise,
    })),
  });
}

// Times here are o'clock in India, built as real instants rather than through
// the host's clock. Written the local way they silently meant something else on
// a UTC machine, which is the ambiguity the code under test no longer has.
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

function at(hour: number): Date {
  return new Date(Date.UTC(2026, 5, 15, hour, 0, 0, 0) - IST_OFFSET_MS);
}

describe("price-history advisor", () => {
  it("returns null until enough data exists (cold start)", async () => {
    const result = await predictFromHistory("food", "cold-dish", at(12));
    expect(result).toBeNull();
  });

  it("suggests waiting when a cheaper hour is coming up", async () => {
    const key = "history-dish-1";
    await seed("food", key, 19, [30000, 30200, 29800]); // now: ~₹300
    await seed("food", key, 20, [20000, 20100, 19900]); // +1h: ~₹200

    const result = await predictFromHistory("food", key, at(19));
    expect(result).not.toBeNull();
    expect(result!.action).toBe("wait");
    expect(result!.source).toBe("history");
    expect(result!.expectedSavingPaise).toBeGreaterThan(9000);
    expect(result!.code).toEqual({ code: "historyWaitFood", params: { rupees: "100", minutes: "60" } });
  });

  it("asks a rider to book, not order, when waiting would pay", async () => {
    const key = "history-auto-1";
    await seed("ride", key, 18, [25000, 25100, 24900]);
    await seed("ride", key, 20, [15000, 15100, 14900]); // two hours on, ₹100 less
    const result = await predictFromHistory("ride", key, at(18));
    expect(result!.message).toMatch(/Book now, or wait and save\?$/);
    expect(result!.code).toEqual({ code: "historyWaitRide", params: { rupees: "100", minutes: "120" } });
  });

  it("says order now when the current hour is already cheapest", async () => {
    const key = "history-dish-2";
    await seed("food", key, 13, [15000, 15100, 14900]); // now: cheapest
    await seed("food", key, 14, [18000, 18200, 17800]); // +1h: pricier

    const result = await predictFromHistory("food", key, at(13));
    expect(result).not.toBeNull();
    expect(result!.action).toBe("order_now");
    expect(result!.code).toEqual({ code: "historyNow" });
  });

  it("ignores trivial differences under ₹10", async () => {
    const key = "history-dish-3";
    await seed("food", key, 10, [20000, 20000, 20000]);
    await seed("food", key, 11, [19950, 19950, 19950]); // only ₹0.50 cheaper

    const result = await predictFromHistory("food", key, at(10));
    expect(result!.action).toBe("order_now");
  });

  it("recordObservation persists a row", async () => {
    recordObservation("ride", "test-vehicle", 12345, at(8));
    // fire-and-forget — give it a tick to flush
    await new Promise((r) => setTimeout(r, 100));
    const count = await prisma.priceObservation.count({
      where: { key: "test-vehicle" },
    });
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe("price-history endpoint", () => {
  it("returns daily low prices for a dish", async () => {
    const { agent } = await authedAgent();
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      return d;
    };
    // Two days of data; day -1 has a lower min than day -2.
    await prisma.priceObservation.createMany({
      data: [
        { domain: "food", key: "chart-dish", hour: 12, weekday: 0, bestPaise: 20000, createdAt: day(2) },
        { domain: "food", key: "chart-dish", hour: 13, weekday: 0, bestPaise: 19000, createdAt: day(2) },
        { domain: "food", key: "chart-dish", hour: 12, weekday: 0, bestPaise: 15000, createdAt: day(1) },
      ],
    });

    const res = await agent
      .get("/api/food/dishes/chart-dish/price-history?days=30")
      .expect(200);
    expect(res.body.points.length).toBe(2);
    // Day -2 min should be 19000 (the lower of the two), day -1 should be 15000.
    const prices = res.body.points.map((p: { pricePaise: number }) => p.pricePaise);
    expect(prices).toContain(19000);
    expect(prices).toContain(15000);
  });
});
