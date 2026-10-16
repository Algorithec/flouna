import { describe, expect, it } from "vitest";
import { actionFromModel, MODEL_ACTION_KINDS } from "../src/modules/agent/fromModel.js";
import { handleModelAction, EMPTY_STATE } from "../src/modules/agent/index.js";
import { JSON_SCHEMA, JSON_SHAPE, SYSTEM_PROMPT } from "../src/modules/chat/llm/prompt.js";
import { parseIntent } from "../src/modules/chat/llm/types.js";

// Instructions the rules do not recognise are read by the model, which may
// only name one of the agent's actions. These pin the contract between the
// two: what the model can say, and that nothing it says gets past the agent's
// own schema.

/** A model answer as structured outputs fills it: unused fields are "none", 0, "" or false. */
const filled = (over: Record<string, unknown>) => ({
  kind: "cart.show",
  targetBy: "none",
  targetPosition: 0,
  targetName: "",
  qty: 0,
  members: 0,
  withMyItems: false,
  pick: "none",
  setting: "none",
  on: false,
  value: "",
  weeklyRupees: 0,
  ...over,
});

describe("reading the model's action", () => {
  it.each([
    [{ kind: "cart.set_qty", targetBy: "last", qty: 2 }, { kind: "cart.set_qty", target: { by: "last" }, qty: 2 }],
    [{ kind: "cart.remove", targetBy: "name", targetName: "Momos" }, { kind: "cart.remove", target: { by: "name", text: "momos" } }],
    [{ kind: "cart.add", targetBy: "position", targetPosition: 2, qty: 3 }, { kind: "cart.add", target: { by: "position", index: 1 }, qty: 3 }],
    [{ kind: "cart.add", targetBy: "last" }, { kind: "cart.add", target: { by: "last" }, qty: 1 }],
    [{ kind: "group.create", members: 4 }, { kind: "group.create", members: 4, withMyItems: false }],
    [{ kind: "select", pick: "cheapest" }, { kind: "select", index: null, pick: "cheapest" }],
    [{ kind: "select", targetPosition: 2 }, { kind: "select", index: 1, pick: null }],
    [{ kind: "ride.group_mode", value: "shared" }, { kind: "ride.group_mode", mode: "shared" }],
    [{ kind: "settings.toggle", setting: "activityStatus", on: false }, { kind: "settings.toggle", setting: "activityStatus", on: false }],
    [{ kind: "settings.budget", weeklyRupees: 0 }, { kind: "settings.budget", weeklyRupees: null }],
    [{ kind: "settings.budget", weeklyRupees: 2500 }, { kind: "settings.budget", weeklyRupees: 2500 }],
    [{ kind: "settings.language", value: "kn" }, { kind: "settings.language", lang: "kn" }],
    [{ kind: "navigate", value: "security" }, { kind: "navigate", to: "security" }],
  ])("%j", (over, expected) => {
    expect(actionFromModel(filled(over))).toEqual(expected);
  });

  it("reads null as absent too, for providers asked for JSON in the prompt", () => {
    const withNulls = Object.fromEntries(Object.entries(filled({ kind: "cart.set_qty", targetBy: "last", qty: 2 })).map(([k, v]) => [k, v === "none" || v === 0 || v === "" ? null : v]));
    expect(actionFromModel({ ...withNulls, qty: 2 })).toEqual({ kind: "cart.set_qty", target: { by: "last" }, qty: 2 });
  });

  it.each([
    ["an unknown kind", { kind: "orders.cancel" }],
    ["a quantity over the cap", { kind: "cart.add", targetBy: "last", qty: 500 }],
    ["a setting that does not exist", { kind: "settings.toggle", setting: "role", on: true }],
    ["a language the app does not have", { kind: "settings.language", value: "fr" }],
    ["a screen that does not exist", { kind: "navigate", value: "admin" }],
    ["a group ride with no head count", { kind: "ride.group" }],
    ["a selection of nothing", { kind: "select" }],
    ["a quantity change with no quantity", { kind: "cart.set_qty", targetBy: "last", qty: 0 }],
  ])("refuses %s", (_label, over) => {
    expect(actionFromModel(filled(over))).toBeNull();
  });

  it("never lets the model say yes or no for the customer", () => {
    expect(MODEL_ACTION_KINDS).not.toContain("confirm");
    expect(MODEL_ACTION_KINDS).not.toContain("cancel");
    expect(actionFromModel(filled({ kind: "confirm" }))).toBeNull();
  });

  it("answers an action it cannot read plainly, doing nothing", async () => {
    const r = await handleModelAction(filled({ kind: "settings.language", value: "fr" }), "nobody", EMPTY_STATE);
    expect(r.action.ok).toBe(false);
    expect(r.reply).toMatch(/say it another way/);
    expect(r.state).toBe(EMPTY_STATE);
  });
});

describe("the contract the model is bound to", () => {
  const props = JSON_SCHEMA.properties as Record<string, any>;

  it("offers action as a domain, in the schema, the prose shape and the instructions", () => {
    expect(props.domain.enum).toContain("action");
    expect(JSON_SHAPE).toContain('"action"');
    expect(SYSTEM_PROMPT).toContain('domain "action"');
  });

  it("requires every action field, so a default never hides one the model skipped", () => {
    const action = props.action;
    expect(Object.keys(action.properties).sort()).toEqual([...action.required].sort());
    expect(action.properties.kind.enum).toEqual([...MODEL_ACTION_KINDS]);
    for (const field of action.required as string[]) expect(JSON_SHAPE).toContain(`"${field}"`);
  });

  it("stays within the 16 nullable fields structured outputs accept", () => {
    // Over the limit, Anthropic refuses the whole schema and every message
    // falls through to the next provider with nothing but a log line to say so.
    let unions = 0;
    const walk = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.type) || Array.isArray(node.anyOf)) unions++;
      for (const v of Object.values(node.properties ?? {})) walk(v);
    };
    walk(JSON_SCHEMA);
    expect(unions).toBeLessThanOrEqual(16);
  });

  it("accepts an answer with an action and drops an empty one", () => {
    const withAction = parseIntent({ domain: "action", reply: "Done.", action: filled({ kind: "cart.show" }) });
    expect(withAction.domain).toBe("action");
    expect(parseIntent({ domain: "greeting", reply: "Hi", action: null }).action).toBeUndefined();
  });
});
