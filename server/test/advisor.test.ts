import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADVICE_CODES,
  adviseFoodByRules as adviseFood,
  adviseRideByRules as adviseRide,
} from "../src/modules/advisor/advisor.service.js";

// Times here are o'clock in India, built as real instants rather than through
// the host's clock. Written the local way they silently meant something else on
// a UTC machine, which is the ambiguity the code under test no longer has.
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

function at(hour: number, minute = 0): Date {
  const d = new Date(Date.UTC(2026, 5, 15, hour, minute, 0, 0) - IST_OFFSET_MS);
  return d;
}

describe("food advisor", () => {
  it("says order now inside an offer window", () => {
    const advice = adviseFood(at(13)); // lunch window 12–15
    expect(advice.action).toBe("order_now");
    expect(advice.message).toContain("lunch-hour deal");
  });

  it("suggests waiting when a big offer starts soon", () => {
    const advice = adviseFood(at(19)); // dinner offer at 20:00
    expect(advice.action).toBe("wait");
    expect(advice.expectedSavingPaise).toBe(10000);
    expect(advice.waitMinutes).toBe(60);
    expect(advice.message).toContain("₹100");
  });

  it("does not suggest absurdly long waits", () => {
    const advice = adviseFood(at(2)); // next window is 10h away
    expect(advice.action).toBe("order_now");
  });
});

describe("ride advisor", () => {
  it("flags off-peak as the best time to book", () => {
    const advice = adviseRide(at(14));
    expect(advice.action).toBe("order_now");
    expect(advice.message).toContain("Off-peak");
  });

  it("suggests a short wait near the end of surge", () => {
    const advice = adviseRide(at(20, 30)); // evening surge ends 21:00
    expect(advice.action).toBe("wait");
    expect(advice.waitMinutes).toBe(30);
  });

  it("is honest mid-surge when waiting won't help soon", () => {
    const advice = adviseRide(at(17, 30)); // 3.5h of surge left
    expect(advice.action).toBe("order_now");
    expect(advice.message).toContain("peak");
  });
});

// The English sentence is what the server writes. The app shows the reader's
// language from the code, so a sentence without one stays English for everyone.
describe("advice in the reader's language", () => {
  it("carries a code on every answer, with the figures a wait needs", () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 30]) {
        for (const advice of [adviseFood(at(hour, minute)), adviseRide(at(hour, minute))]) {
          expect(advice.code, advice.message).toBeDefined();
          if (advice.action === "wait") {
            expect(advice.code!.params).toEqual({ rupees: expect.any(String), minutes: String(advice.waitMinutes) });
          }
        }
      }
    }
  });

  it("names the offer and the wait", () => {
    expect(adviseFood(at(13)).code).toEqual({ code: "foodLiveLunch" });
    expect(adviseFood(at(19)).code).toEqual({ code: "foodSoonDinner", params: { rupees: "100", minutes: "60" } });
    expect(adviseRide(at(20, 30)).code).toEqual({ code: "rideEasing", params: { rupees: "50", minutes: "30" } });
  });

  it("has every code translated in all six of the app's languages", () => {
    const dictionaries = readFileSync(new URL("../../web/lib/i18n/dictionaries.ts", import.meta.url), "utf8");
    for (const code of ADVICE_CODES) {
      expect(dictionaries.split(`"adv.m.${code}":`).length - 1, code).toBe(6);
    }
  });
});
