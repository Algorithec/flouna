import { describe, expect, it } from "vitest";
import {
  estimateTimeValue,
  rupeesPerMinute,
  type PricedDecision,
} from "../src/modules/advisor/priceOfTime.service.js";

// Reading what a minute is worth to somebody out of what they actually chose.
//
// The founder's guide gives the example directly: pick ₹270 at 25 minutes over
// ₹220 at 40 minutes and you have paid 50 rupees for 15 minutes. These tests
// are that arithmetic, plus the cases where a person is not being consistent.

/** ₹270 / 25min chosen over ₹220 / 40min → at least ₹3.33 a minute. */
const paidForSpeed: PricedDecision = {
  results: [
    { key: "fast", pricePaise: 27000, etaMinutes: 25 },
    { key: "slow", pricePaise: 22000, etaMinutes: 40 },
  ],
  selectedKey: "fast",
};

/** The same options, the other choice → at most ₹3.33 a minute. */
const waitedToSave: PricedDecision = { ...paidForSpeed, selectedKey: "slow" };

describe("price of time, read from choices", () => {
  it("says nothing about a person who has chosen nothing", () => {
    expect(estimateTimeValue([])).toBeNull();
  });

  it("a paid-for-speed choice sets a floor", () => {
    const v = estimateTimeValue([paidForSpeed])!;
    // 5000 paise for 15 minutes.
    expect(v.lowerPaisePerMinute).toBe(333);
    expect(v.upperPaisePerMinute).toBeNull();
    expect(rupeesPerMinute(v)).toBeCloseTo(3.3, 1);
  });

  it("a waited-to-save choice sets a ceiling", () => {
    const v = estimateTimeValue([waitedToSave])!;
    expect(v.upperPaisePerMinute).toBe(333);
    expect(v.lowerPaisePerMinute).toBe(0);
  });

  it("opposing choices close the range from both sides", () => {
    // Paid ₹60 to save 10 minutes once (≥ ₹6/min), declined ₹100 for
    // 10 minutes another time (≤ ₹10/min). The answer is between them.
    const decisions: PricedDecision[] = [
      {
        results: [
          { key: "a", pricePaise: 16000, etaMinutes: 20 },
          { key: "b", pricePaise: 10000, etaMinutes: 30 },
        ],
        selectedKey: "a",
      },
      {
        results: [
          { key: "c", pricePaise: 30000, etaMinutes: 20 },
          { key: "d", pricePaise: 20000, etaMinutes: 30 },
        ],
        selectedKey: "d",
      },
    ];
    const v = estimateTimeValue(decisions)!;
    expect(v.lowerPaisePerMinute).toBe(600);
    expect(v.upperPaisePerMinute).toBe(1000);
    expect(v.paisePerMinute).toBe(800);
  });

  it("ignores an option that was worse on both counts", () => {
    // Refusing something slower AND dearer needs no theory of time.
    const v = estimateTimeValue([
      {
        results: [
          { key: "best", pricePaise: 10000, etaMinutes: 20 },
          { key: "worse", pricePaise: 20000, etaMinutes: 40 },
        ],
        selectedKey: "best",
      },
    ]);
    expect(v).toBeNull();
  });

  it("counts a dearer, slower choice as being about something else", () => {
    // Almost certainly quality. Recorded rather than hidden, because a profile
    // built mostly from these should not be trusted.
    const v = estimateTimeValue([
      {
        results: [
          { key: "premium", pricePaise: 40000, etaMinutes: 45 },
          { key: "quick-cheap", pricePaise: 20000, etaMinutes: 20 },
        ],
        selectedKey: "premium",
      },
    ]);
    expect(v).toBeNull();
  });

  it("does not report an impossible range when the choices contradict", () => {
    const contradictory: PricedDecision[] = [
      // ≥ ₹10/min
      {
        results: [
          { key: "a", pricePaise: 20000, etaMinutes: 20 },
          { key: "b", pricePaise: 10000, etaMinutes: 30 },
        ],
        selectedKey: "a",
      },
      // ≤ ₹2/min, which cannot also be true
      {
        results: [
          { key: "c", pricePaise: 12000, etaMinutes: 20 },
          { key: "d", pricePaise: 10000, etaMinutes: 30 },
        ],
        selectedKey: "d",
      },
    ];
    const v = estimateTimeValue(contradictory)!;
    expect(v.lowerPaisePerMinute).toBeLessThanOrEqual(v.upperPaisePerMinute!);
    expect(v.inconsistent).toBeGreaterThan(0);
    expect(v.confident).toBe(false);
  });

  it("stays unconfident until enough choices agree", () => {
    const v = estimateTimeValue([paidForSpeed, waitedToSave])!;
    expect(v.informative).toBe(2);
    expect(v.confident).toBe(false);
  });

  it("becomes confident once a consistent picture builds up", () => {
    // Six trade-offs, all agreeing a minute is worth between ₹5 and ₹7.
    const decisions: PricedDecision[] = [];
    for (let i = 0; i < 3; i++) {
      decisions.push({
        results: [
          { key: `f${i}`, pricePaise: 15000 + i, etaMinutes: 20 },
          { key: `s${i}`, pricePaise: 10000 + i, etaMinutes: 30 },
        ],
        selectedKey: `f${i}`, // ≥ ₹5/min
      });
      decisions.push({
        results: [
          { key: `x${i}`, pricePaise: 17000 + i, etaMinutes: 20 },
          { key: `y${i}`, pricePaise: 10000 + i, etaMinutes: 30 },
        ],
        selectedKey: `y${i}`, // ≤ ₹7/min
      });
    }
    const v = estimateTimeValue(decisions)!;
    expect(v.informative).toBe(6);
    expect(v.lowerPaisePerMinute).toBe(500);
    expect(v.upperPaisePerMinute).toBe(700);
    expect(v.confident).toBe(true);
    expect(rupeesPerMinute(v)).toBeCloseTo(6, 1);
  });

  it("two people making different choices get different numbers", () => {
    // The point of the whole exercise: one bucket cannot hold both of these.
    const hurried = estimateTimeValue([
      {
        results: [
          { key: "a", pricePaise: 50000, etaMinutes: 15 },
          { key: "b", pricePaise: 20000, etaMinutes: 45 },
        ],
        selectedKey: "a",
      },
    ])!;
    const patient = estimateTimeValue([
      {
        results: [
          { key: "a", pricePaise: 50000, etaMinutes: 15 },
          { key: "b", pricePaise: 20000, etaMinutes: 45 },
        ],
        selectedKey: "b",
      },
    ])!;
    expect(hurried.lowerPaisePerMinute).toBe(1000);
    expect(patient.upperPaisePerMinute).toBe(1000);
    expect(hurried.paisePerMinute).toBeGreaterThan(patient.paisePerMinute);
  });
});
