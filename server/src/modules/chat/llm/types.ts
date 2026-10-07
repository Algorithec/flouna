import { z } from "zod";

// The ONLY thing the LLM is allowed to produce — a fixed intent schema.
// This is the strongest layer of the firewall: the model cannot write code,
// essays, or anything else, because the API enforces this shape.
export const intentSchema = z.object({
  // "combo" = one message asking for food AND a ride; both sub-objects set.
  // "shop" = shopping for a product (electronics, fashion, etc.).
  domain: z.enum(["food", "ride", "shop", "combo", "greeting", "out_of_scope"]),
  reply: z
    .string()
    .max(280)
    .describe("One short, friendly sentence acknowledging the request"),
  food: z
    .object({
      item: z.string().max(80).describe("The dish or cuisine requested"),
      budgetPaise: z.number().int().positive().nullable(),
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
      budgetPaise: z.number().int().positive().nullable().default(null),
      maxEtaMinutes: z.number().int().positive().nullable().default(null),
      maxPickupMinutes: z.number().int().positive().nullable().default(null),
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
});

export type Intent = z.infer<typeof intentSchema>;

export interface LlmProvider {
  name: string;
  extractIntent(userMessage: string): Promise<Intent>;
}
