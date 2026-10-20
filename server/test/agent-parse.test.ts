import { describe, expect, it } from "vitest";
import { parseInstruction } from "../src/modules/agent/parse.js";

// How chat reads instructions. Anything not recognised must fall through to
// search (null), never be guessed into an action.

describe("reading instructions", () => {
  it.each([
    ["Add it to my cart", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["Add that too", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["add 2 of the second one", { kind: "cart.add", target: { by: "position", index: 1 }, qty: 2 }],
    ["add option 3", { kind: "cart.add", target: { by: "position", index: 2 }, qty: 1 }],
    ["add another", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["add the chicken 65", { kind: "cart.add", target: { by: "name", text: "chicken 65" }, qty: 1 }],
    ["order it", { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    ["remove the biryani", { kind: "cart.remove", target: { by: "name", text: "biryani" } }],
    ["remove it", { kind: "cart.remove", target: { by: "last" } }],
    ["change biryani to 3", { kind: "cart.set_qty", target: { by: "name", text: "biryani" }, qty: 3 }],
    ["show my cart", { kind: "cart.show" }],
    ["what's in my cart?", { kind: "cart.show" }],
    ["clear my cart", { kind: "cart.clear" }],
    ["place the order", { kind: "checkout" }],
    ["checkout", { kind: "checkout" }],
    ["Create a group order for four members, but order one biryani and one starter only for me", { kind: "group.create", members: 4, withMyItems: true }],
    ["start a group order", { kind: "group.create", members: null, withMyItems: false }],
    ["make a group for 6 people", { kind: "group.create", members: 6, withMyItems: false }],
    ["show my group order", { kind: "group.show" }],
    ["turn off email updates", { kind: "settings.toggle", setting: "emailUpdates", on: false }],
    ["stop payment emails", { kind: "settings.toggle", setting: "emailMoneyUpdates", on: false }],
    ["enable smart suggestions", { kind: "settings.toggle", setting: "smartSuggestions", on: true }],
    ["hide my activity status", { kind: "settings.toggle", setting: "activityStatus", on: false }],
    ["make my profile private", { kind: "settings.visibility", value: "nobody" }],
    ["set my weekly budget to 2500", { kind: "settings.budget", weeklyRupees: 2500 }],
    ["remove my budget", { kind: "settings.budget", weeklyRupees: null }],
    ["switch to telugu", { kind: "settings.language", lang: "te" }],
    ["turn on dark mode", { kind: "settings.theme", theme: "dark" }],
    ["turn off two factor", { kind: "navigate", to: "security" }],
    ["delete my account", { kind: "navigate", to: "security" }],
    ["open my orders", { kind: "navigate", to: "orders" }],
    ["yes", { kind: "confirm" }],
    ["ok do it", { kind: "confirm" }],
    ["no", { kind: "cancel" }],
  ])("%s", (text, action) => {
    expect(parseInstruction(text)).toEqual(action);
  });

  it.each([
    "Find the best chicken biryani under ₹300",
    "order biryani",
    "I want pizza",
    "ride to the airport under 700",
    "hi",
    "cancel my order",
    "what is the cheapest dessert",
    "biryani and a cab home",
    "",
  ])("%s goes to search, not an action", (text) => {
    expect(parseInstruction(text)).toBeNull();
  });
});
