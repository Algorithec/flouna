import { describe, expect, it } from "vitest";
import { JSON_SCHEMA, JSON_SHAPE, SYSTEM_PROMPT } from "../src/modules/chat/llm/prompt.js";
import { intentSchema } from "../src/modules/chat/llm/types.js";

// The contract between the model and the recommender.
//
// This exists because of a bug that produced no error anywhere. `priority` was
// in the Zod intent type with `.default("balanced")`, and missing from the JSON
// schema the structured-output call is bound to. The model therefore could not
// return it, Zod filled the default, and every request reached the recommender
// as "balanced" — so "top-rated biryani" picked exactly what "cheapest biryani"
// picked, and nothing logged a thing.
//
// A default is the dangerous part: it turns a broken contract into a plausible
// answer. So the check is structural rather than behavioural — every field the
// intent type can carry must be requestable from the model.

/** Field names the Zod object for a domain accepts. */
function zodFields(key: "food" | "ride" | "shop"): string[] {
  const shape = intentSchema.shape[key];
  // .optional() wraps the object; reach through to the shape underneath.
  const inner = (shape as unknown as { unwrap: () => { shape: object } }).unwrap();
  return Object.keys(inner.shape);
}

function schemaFields(key: "food" | "ride" | "shop"): string[] {
  const props = (JSON_SCHEMA.properties as Record<string, { properties: object }>)[key];
  return Object.keys(props.properties);
}

function requiredFields(key: "food" | "ride" | "shop"): string[] {
  const props = (JSON_SCHEMA.properties as Record<string, { required: string[] }>)[key];
  return props.required;
}

describe("the model can return every field the recommender reads", () => {
  for (const domain of ["food", "ride", "shop"] as const) {
    it(`${domain}: no field is in the intent type but missing from the schema`, () => {
      const missing = zodFields(domain).filter((f) => !schemaFields(domain).includes(f));
      expect(missing, `${domain} fields the model cannot return`).toEqual([]);
    });

    it(`${domain}: every schema field is required, so a default never hides a gap`, () => {
      // An optional field the model skips is indistinguishable from a field it
      // was never asked for. Requiring them all makes an omission loud.
      const optional = schemaFields(domain).filter((f) => !requiredFields(domain).includes(f));
      expect(optional, `${domain} fields the model may silently skip`).toEqual([]);
    });

    it(`${domain}: priority is requestable and constrained to the four rules`, () => {
      const props = (
        JSON_SCHEMA.properties as Record<
          string,
          { properties: Record<string, { enum?: string[] }> }
        >
      )[domain];
      expect(props.properties.priority).toBeDefined();
      expect(props.properties.priority.enum).toEqual([
        "price",
        "rating",
        "speed",
        "balanced",
      ]);
    });
  }

  // The same contract, for the providers asked for JSON in prose rather than
  // bound to the schema above. The check above never covered them: a field
  // could be returnable from Claude and silently never requested from
  // DeepSeek or Gemini, and zod's defaults would hide it exactly as they once
  // hid "priority".
  for (const domain of ["food", "ride", "shop"] as const) {
    it(`${domain}: the prose shape names every field the intent type carries`, () => {
      const block = JSON_SHAPE.slice(JSON_SHAPE.indexOf(`"${domain}"?:`));
      const own = block.slice(0, block.indexOf("}") + 1);
      const missing = zodFields(domain).filter((f) => !own.includes(`"${f}"`));
      expect(missing, `${domain} fields DeepSeek and Gemini are never asked for`).toEqual([]);
    });
  }

  it("the prompt explains how to fill each stated limit", () => {
    // Returnable is not the same as correct. Without instructions a model
    // leaves these null, and a pickup limit read from a whole-trip time would
    // remove rides for a reason the rider never gave.
    expect(SYSTEM_PROMPT).toMatch(/maxEtaMinutes/);
    expect(SYSTEM_PROMPT).toMatch(/maxPickupMinutes/);
    expect(SYSTEM_PROMPT).toMatch(/whole trip/i);
  });

  it("the prompt tells the model how to choose a priority", () => {
    // The schema makes the field returnable; the prompt is what makes it
    // correct. Both providers that had this rule inline worked; the shared
    // prompt, used by the provider actually configured, did not.
    expect(SYSTEM_PROMPT).toMatch(/priority/i);
    expect(SYSTEM_PROMPT).toMatch(/cheapest|cheap|budget/i);
    expect(SYSTEM_PROMPT).toMatch(/top-rated|highest rated/i);
    expect(SYSTEM_PROMPT).toMatch(/fastest|quick/i);
  });

  it("parses a complete intent the way a provider would return it", () => {
    const intent = intentSchema.parse({
      domain: "food",
      reply: "Looking for the cheapest biryani.",
      food: { item: "biryani", budgetPaise: null, dietary: "any", priority: "price" },
    });
    expect(intent.food?.priority).toBe("price");
  });

  it("shows what the bug looked like: an absent priority becomes balanced", () => {
    // Kept as documentation. This parse succeeds, which is precisely why the
    // fault was invisible — the guard is the schema check above, not this.
    const intent = intentSchema.parse({
      domain: "food",
      reply: "Looking for a top-rated biryani.",
      food: { item: "biryani", budgetPaise: null, dietary: "any" },
    });
    expect(intent.food?.priority).toBe("balanced");
  });
});

// JSON mode models often fill the parts they did not use with null. Every
// provider parses through parseIntent, so an empty part is read as absent
// instead of failing the whole answer and falling back to another provider.
describe("an answer with empty parts", () => {
  it("is read, not rejected", async () => {
    const { parseIntent } = await import("../src/modules/chat/llm/types.js");
    const intent = parseIntent({
      domain: "ride",
      reply: "Booking a cab",
      food: null,
      shop: null,
      ride: { pickup: null, drop: "Airport", vehicle: "cab", budgetPaise: null, maxPickupMinutes: null, priority: "balanced", scheduleAt: null },
    });
    expect(intent.domain).toBe("ride");
    expect(intent.food).toBeUndefined();
  });

  it("is what every provider parses with", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["anthropic", "deepseek", "google", "nvidia", "ollama", "selfHosted"]) {
      const src = readFileSync(`src/modules/chat/llm/${f}.ts`, "utf8");
      expect(src, `${f}.ts`).toContain("parseIntent(");
      expect(src, `${f}.ts`).not.toContain("intentSchema.parse(");
    }
  });
});
