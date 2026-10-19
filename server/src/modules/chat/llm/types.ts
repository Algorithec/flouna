import { z } from "zod";
import { modelActionSchema } from "../../agent/fromModel.js";

// The ONLY thing the LLM is allowed to produce — a fixed intent schema.
// This is the strongest layer of the firewall: the model cannot write code,
// essays, or anything else, because the API enforces this shape.
export const intentSchema = z.object({
  // "combo" = one message asking for food AND a ride; both sub-objects set.
  // "shop" = shopping for a product (electronics, fashion, etc.).
  // "action" = an instruction to do something in the app (add to cart, pick
  // an option, change a setting), carried in `action`.
  domain: z.enum(["food", "ride", "shop", "combo", "action", "greeting", "out_of_scope"]),
  reply: z
    .string()
    .max(280)
    .describe("One short, friendly sentence acknowledging the request"),
  food: z
    .object({
      item: z.string().max(80).describe("The dish or cuisine requested"),
      budgetPaise: z.number().int().positive().nullable(),
      // "within 35 minutes" → 35. A stated limit, enforced before ranking, so
      // an option arriving later is removed rather than ranked lower.
      maxEtaMinutes: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe("Latest acceptable delivery in minutes if stated, else null"),
      dietary: z.enum(["veg", "nonveg", "any"]).default("any"),
      // What the user cares about most: "rating" for top-rated/best, "price"
      // for cheap/budget, "speed" for fast/quick, else "balanced".
      priority: z
        .enum(["price", "rating", "speed", "balanced"])
        .default("balanced"),
    })
    .optional(),
  ride: z
    .object({
      pickup: z.string().max(120).nullable(),
      drop: z.string().max(120).describe("Destination"),
      vehicle: z.enum(["bike", "auto", "cab", "any"]).default("any"),
      // "under ₹300" → 30000, the same meaning it has for food and shopping, so
      // the model reads a price the same way whatever is being bought.
      budgetPaise: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe("Maximum fare in paise if stated, else null"),
      // "don't want to wait more than 5 minutes" → 5. How long until pickup,
      // not the whole journey.
      maxPickupMinutes: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe("Longest acceptable wait for pickup in minutes if stated, else null"),
      priority: z
        .enum(["price", "rating", "speed", "balanced"])
        .default("balanced"),
      // "book a cab at 10pm" → "22:00". Resolved server-side to the next
      // occurrence of that local time (today or tomorrow).
      scheduleAt: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .nullable()
        .default(null)
        .describe(
          "24h HH:mm if the user asked to book for a later time, else null",
        ),
    })
    .optional(),
  shop: z
    .object({
      item: z.string().max(80).describe("The product the user wants to buy"),
      budgetPaise: z.number().int().positive().nullable(),
      category: z
        .enum(["electronics", "fashion", "home", "appliances", "any"])
        .default("any"),
      priority: z
        .enum(["price", "rating", "speed", "balanced"])
        .default("balanced"),
    })
    .optional(),
  // Read by agent/fromModel.ts, which checks it against the agent's own
  // action schema before anything is done.
  action: modelActionSchema.optional(),
});

export type Intent = z.infer<typeof intentSchema>;

/**
 * Validates a model's answer as an intent.
 *
 * JSON mode models often fill the parts they did not use with null, answering
 * a cab request with "food": null beside a real ride. The schema rejects a null
 * part, so the whole answer failed and chat fell back to another provider,
 * throwing away a correct reading. An empty part is the same as an absent
 * one, so it is dropped first. Every provider parses through here.
 */
export function parseIntent(raw: unknown): Intent {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = { ...(raw as Record<string, unknown>) };
    for (const part of ["food", "ride", "shop", "action"]) {
      if (obj[part] === null) delete obj[part];
    }
    return intentSchema.parse(obj);
  }
  return intentSchema.parse(raw);
}

export interface LlmProvider {
  name: string;
  extractIntent(userMessage: string): Promise<Intent>;
}
