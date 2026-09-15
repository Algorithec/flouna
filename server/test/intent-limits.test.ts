import { describe, expect, it } from "vitest";
import { DemoProvider } from "../src/modules/chat/llm/demo.js";

// Reading limits out of what a customer typed.
//
// A stated price is enforced now, so a number misread as a price no longer
// fails quietly: it empties the results. That makes the rules asymmetric. A
// limit missed shows a few extra options; a limit invented shows nothing. So
// these check the invented kind hardest, across phrasings rather than a
// handful of fixed sentences.

const engine = new DemoProvider();
const food = async (m: string) => (await engine.extractIntent(m)).food;
const ride = async (m: string) => (await engine.extractIntent(m)).ride;

describe("a number is not a price unless it is one", () => {
  // Every one of these was read as a price before, and every one would now
  // return an empty screen if it still were.
  it.each([
    "chicken biryani within 35 minutes",
    "get me biryani in 30 minutes",
    "pizza delivered in 45 mins",
    "biryani in under 40 minutes",
    "order 12 samosas",
    "dinner for 10 people",
    "lunch for 4 persons",
    "biryani for 2 plates",
    "order 3 pizzas",
    "a 4.5 star biryani",
    "biryani within 2 hours",
  ])("%s", async (message) => {
    expect((await food(message))?.budgetPaise ?? null).toBeNull();
  });

  // The layers above overlap. A bare number needs a price word, and "within"
  // or "for" need a number of at least 50, so most of those stay unread as a
  // price even without the unit check. These are the cases only the unit check
  // stops: a word that genuinely means a ceiling, followed by a time. Removing
  // that check once failed a single test in this file, which was too thin a
  // guard for the layer doing this work.
  it.each([
    "biryani under 45 minutes",
    "pizza below 30 mins",
    "food in max 20 minutes",
    "dosa less than 25 minutes away",
    "thali up to 40 minutes",
    "biryani under 90 minutes",
  ])("%s is a time, although its word means a ceiling", async (message) => {
    expect((await food(message))?.budgetPaise ?? null).toBeNull();
  });
});

describe("a price is still a price", () => {
  it.each([
    ["biryani under ₹300", 30000],
    ["biryani under 300", 30000],
    ["veg thali under 200 rupees", 20000],
    ["paneer butter masala for 400", 40000],
    ["i want food under ₹1,200", 120000],
    ["biryani below rs 250", 25000],
  ])("%s", async (message, paise) => {
    expect((await food(message))?.budgetPaise).toBe(paise);
  });

  it("takes the price, not the minutes, whichever comes first", async () => {
    // The earlier reader took the first number, so this order was a ₹35
    // budget that ignored the ₹300 the customer actually named.
    for (const message of [
      "biryani within 35 minutes under 300",
      "biryani under 300 within 35 minutes",
    ]) {
      const f = await food(message);
      expect(f?.budgetPaise).toBe(30000);
      expect(f?.maxEtaMinutes).toBe(35);
    }
  });
});

describe("a latest delivery time", () => {
  it.each([
    ["biryani within 35 minutes", 35],
    ["pizza in 45 mins", 45],
    ["dosa within half an hour", 30],
    ["biryani within an hour", 60],
    ["thali within 2 hours", 120],
  ])("%s", async (message, minutes) => {
    expect((await food(message))?.maxEtaMinutes).toBe(minutes);
  });

  it.each(["biryani under 300", "I want chicken biryani", "biryani at 9pm"])(
    "sets none for %s",
    async (message) => {
      expect((await food(message))?.maxEtaMinutes ?? null).toBeNull();
    },
  );
});

describe("a longest wait for pickup", () => {
  it.each([
    ["cab to hitec city, dont want to wait more than 5 minutes", 5],
    ["auto to gachibowli, pickup within 4 mins", 4],
    ["bike to madhapur, I will not wait longer than 6 minutes", 6],
  ])("%s", async (message, minutes) => {
    expect((await ride(message))?.maxPickupMinutes).toBe(minutes);
  });

  it("does not treat a limit on the whole trip as a pickup limit", async () => {
    // Reading this as a 30 minute pickup would remove rides for a reason the
    // rider never gave. "arrive" is as often the destination as the vehicle.
    expect((await ride("cab to the airport, need to arrive in 30 minutes"))?.maxPickupMinutes ?? null).toBeNull();
  });
});

describe("the destination survives the limits attached to it", () => {
  it.each([
    ["cab to hitec city under ₹300, dont want to wait more than 5 minutes", "hitec city"],
    ["auto to gachibowli, pickup within 4 mins", "gachibowli"],
    ["bike to madhapur under 150", "madhapur"],
    // The guide's own example.
    ["I need to go to HITEC City now. Under ₹300 and I dont want to wait more than 5 minutes", "HITEC City"],
  ])("%s", async (message, drop) => {
    expect((await ride(message))?.drop).toBe(drop);
  });

  it.each([
    // Places that look like limits and must not be cut.
    ["cab to St. Mary's Church", "St. Mary's Church"],
    ["cab to Uptown mall", "Uptown mall"],
    ["cab to Nowgam road", "Nowgam road"],
    ["cab to Gokul Chat", "Gokul Chat"],
  ])("leaves %s whole", async (message, drop) => {
    expect((await ride(message))?.drop).toBe(drop);
  });
});
