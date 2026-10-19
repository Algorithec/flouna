import { z } from "zod";
import { actionSchema, LANGS, SERVER_TOGGLES, type AgentAction } from "./actions.js";

// Instructions the rules did not recognise, read by the model.
//
// The model may only answer in the fixed intent schema, and an instruction
// comes back as one flat object: a kind and the fields that kind needs. It is
// turned into the same actions the rules produce and checked against the same
// schema, so the model can name an action but never invent one, widen one, or
// skip the question asked before anything hard to undo. "Yes" and "no" stay
// with the rules: a model is not asked to decide whether the customer agreed.

export const MODEL_ACTION_KINDS = [
  "cart.add",
  "cart.remove",
  "cart.set_qty",
  "cart.show",
  "cart.clear",
  "checkout",
  "group.create",
  "group.show",
  "select",
  "ride.book",
  "ride.group",
  "ride.group_mode",
  "settings.toggle",
  "settings.visibility",
  "settings.budget",
  "settings.language",
  "settings.theme",
  "navigate",
] as const;

/** The flat shape the model fills. Every field is present; unused ones are null. */
// Structured outputs fill unused fields with "none", 0, "" or false (the
// schema allows no nullable fields, see prompt.ts); providers asked for JSON
// in the prompt may send null. Both read as absent.
const none = <T>(v: T) => (v === null || v === "none" || v === "" || v === 0 ? null : v);

export const modelActionSchema = z.object({
  kind: z.enum(MODEL_ACTION_KINDS),
  targetBy: z.enum(["last", "position", "name", "none"]).nullable().transform(none),
  /** 1 for the first option shown, 2 for the second. */
  targetPosition: z.number().int().nullable().transform(none),
  targetName: z.string().max(80).nullable().transform(none),
  qty: z.number().int().nullable().transform(none),
  members: z.number().int().nullable().transform(none),
  withMyItems: z.boolean().nullable(),
  pick: z.enum(["cheapest", "fastest", "none"]).nullable().transform(none),
  setting: z.enum([...SERVER_TOGGLES, "none"]).nullable().transform(none),
  on: z.boolean().nullable(),
  /** Visibility, language, theme, place to open, or group ride mode, by kind. */
  value: z.string().max(40).nullable().transform(none),
  /** 0 removes the budget. */
  weeklyRupees: z.number().int().nullable(),
});
export type ModelAction = z.infer<typeof modelActionSchema>;

function target(m: ModelAction) {
  if (m.targetBy === "position" && m.targetPosition !== null) return { by: "position" as const, index: m.targetPosition - 1 };
  if (m.targetBy === "name" && m.targetName) return { by: "name" as const, text: m.targetName.toLowerCase() };
  return { by: "last" as const };
}

/** The action the model named, or null if what it returned is not a valid one. */
export function actionFromModel(raw: unknown): AgentAction | null {
  const parsed = modelActionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  let candidate: unknown;
  switch (m.kind) {
    case "cart.add":
      candidate = { kind: m.kind, target: target(m), qty: m.qty ?? 1 };
      break;
    case "cart.remove":
      candidate = { kind: m.kind, target: target(m) };
      break;
    case "cart.set_qty":
      candidate = { kind: m.kind, target: target(m), qty: m.qty };
      break;
    case "group.create":
      candidate = { kind: m.kind, members: m.members, withMyItems: m.withMyItems ?? false };
      break;
    case "select":
      candidate = { kind: m.kind, index: m.targetPosition !== null ? m.targetPosition - 1 : null, pick: m.pick };
      if (m.targetPosition === null && m.pick === null) return null;
      break;
    case "ride.group":
      candidate = { kind: m.kind, members: m.members };
      break;
    case "ride.group_mode":
      candidate = { kind: m.kind, mode: m.value };
      break;
    case "settings.toggle":
      candidate = { kind: m.kind, setting: m.setting, on: m.on ?? null };
      break;
    case "settings.visibility":
      candidate = { kind: m.kind, value: m.value };
      break;
    case "settings.budget":
      candidate = { kind: m.kind, weeklyRupees: m.weeklyRupees ? m.weeklyRupees : null };
      break;
    case "settings.language":
      candidate = { kind: m.kind, lang: (LANGS as readonly string[]).includes(m.value ?? "") ? m.value : null };
      break;
    case "settings.theme":
      candidate = { kind: m.kind, theme: m.value };
      break;
    case "navigate":
      candidate = { kind: m.kind, to: m.value };
      break;
    default:
      candidate = { kind: m.kind };
  }
  const checked = actionSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}
