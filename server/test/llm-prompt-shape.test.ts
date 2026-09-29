import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_SHAPE, JSON_SCHEMA } from "../src/modules/chat/llm/prompt.js";

// Every provider has to be told the same shape.
//
// A provider arrived with the JSON spec pasted inline instead of imported, and
// the copy was already out of date: it omitted food.maxEtaMinutes,
// ride.budgetPaise and ride.maxPickupMinutes. Selecting that provider would
// have removed every stated limit from the product — the model cannot return a
// field it was never told about, zod fills the absence with null, and the hard
// constraints stop existing with no error anywhere. The same thing happened
// once before with "priority", where "top-rated" and "cheapest" quietly picked
// the same dish.
//
// So the shape lives in one place and this test keeps it there.

const LLM_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/modules/chat/llm");

/** The providers, i.e. everything but the shape itself and the plumbing. */
const PROVIDERS = readdirSync(LLM_DIR).filter(
  (f) =>
    f.endsWith(".ts") &&
    !["prompt.ts", "types.ts", "index.ts", "fallback.ts", "demo.ts"].includes(f),
);

/**
 * Fields a customer's stated limit travels in. Absent from the spec means
 * absent from the answer, which is silent rather than noisy, which is why it
 * needs a test rather than a code review.
 */
const MUST_BE_OFFERED = [
  "maxEtaMinutes",
  "maxPickupMinutes",
  "budgetPaise",
  "priority",
  "dietary",
  "scheduleAt",
];

describe("the intent shape has one definition", () => {
  it("finds the providers", () => {
    // If this list empties, every assertion below passes vacuously.
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(4);
  });

  it.each(PROVIDERS)("%s asks for the shared shape rather than its own copy", (file) => {
    const src = readFileSync(join(LLM_DIR, file), "utf8");
    const importsShape = /JSON_SHAPE|JSON_SCHEMA/.test(src);
    expect(importsShape, `${file} must import the shape from prompt.ts`).toBe(true);
    // A pasted copy, however faithful on the day it was pasted.
    const ownSpec = src.match(/Respond ONLY with a JSON object[^`]*"domain"/);
    expect(ownSpec, `${file} spells out its own spec instead of importing it`).toBeNull();
  });

  it.each(MUST_BE_OFFERED)("the prose shape offers %s", (field) => {
    expect(JSON_SHAPE).toContain(field);
  });

  it.each(MUST_BE_OFFERED)("the structured shape requires %s somewhere", (field) => {
    // Required, not merely present: an optional field is one a model may omit,
    // and an omitted limit is indistinguishable from a limit nobody stated.
    const required = Object.values(
      JSON_SCHEMA.properties as Record<string, { required?: string[] }>,
    ).flatMap((p) => p.required ?? []);
    expect(required).toContain(field);
  });

  it("keeps the two shapes describing the same fields", () => {
    // They are read by different providers — prose for JSON-mode APIs, schema
    // for structured-output ones — so a field added to one and not the other
    // means two providers that disagree about what the product supports.
    const inSchema = new Set(
      Object.values(JSON_SCHEMA.properties as Record<string, { properties?: object }>)
        .flatMap((p) => Object.keys(p.properties ?? {})),
    );
    for (const field of inSchema) {
      expect(JSON_SHAPE, `${field} is in the schema but not in the prose shape`).toContain(field);
    }
  });
});
