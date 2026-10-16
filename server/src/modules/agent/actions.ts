import { z } from "zod";

// What chat can do, as data.
//
// An instruction is turned into one of these before anything happens, and
// only these can happen: there is no path from a message to an arbitrary call.
// Each is carried out for the signed-in customer alone, through the same
// functions the app's own screens use, so chat can never do something the
// customer could not do themselves.

/** Which item an instruction is about. */
export const targetSchema = z.discriminatedUnion("by", [
  // "it", "that", "this one": the most recent relevant item.
  z.object({ by: z.literal("last") }),
  // "the second one", "option 3": position in what was last shown, from 0.
  z.object({ by: z.literal("position"), index: z.number().int().min(0).max(19) }),
  // "the biryani", "chicken 65": matched against what was shown, or the cart.
  z.object({ by: z.literal("name"), text: z.string().min(1).max(80) }),
]);
export type Target = z.infer<typeof targetSchema>;

/** Settings stored on the server, exactly as the Settings screen sets them. */
export const SERVER_TOGGLES = [
  "emailUpdates",
  "smartSuggestions",
  "emailMoneyUpdates",
  "emailTips",
  "shareLocation",
  "activityStatus",
] as const;
export type ServerToggle = (typeof SERVER_TOGGLES)[number];

export const LANGS = ["en", "hi", "mr", "kn", "ta", "te"] as const;

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cart.add"), target: targetSchema, qty: z.number().int().min(1).max(20).default(1) }),
  z.object({ kind: z.literal("cart.remove"), target: targetSchema }),
  z.object({ kind: z.literal("cart.set_qty"), target: targetSchema, qty: z.number().int().min(0).max(20) }),
  z.object({ kind: z.literal("cart.show") }),
  z.object({ kind: z.literal("cart.clear") }),
  z.object({ kind: z.literal("checkout") }),
  z.object({
    kind: z.literal("group.create"),
    // Counting the host: "a group order for four" is 4.
    members: z.number().int().min(2).max(50).nullable(),
    // "only for me": the host's own items go into the group as the host's.
    withMyItems: z.boolean(),
  }),
  z.object({ kind: z.literal("group.show") }),
  z.object({ kind: z.literal("settings.toggle"), setting: z.enum(SERVER_TOGGLES), on: z.boolean() }),
  z.object({ kind: z.literal("settings.visibility"), value: z.enum(["everyone", "contacts", "nobody"]) }),
  z.object({ kind: z.literal("settings.budget"), weeklyRupees: z.number().int().min(100).max(100000).nullable() }),
  z.object({ kind: z.literal("settings.language"), lang: z.enum(LANGS) }),
  z.object({ kind: z.literal("settings.theme"), theme: z.enum(["light", "dark"]) }),
  // Things that need the customer's own hand (a code, a fingerprint): chat
  // takes them to the screen rather than doing it for them.
  z.object({ kind: z.literal("navigate"), to: z.enum(["cart", "orders", "settings", "security", "profile", "groups", "help", "rewards"]) }),
  // "Choose the second option": a ride if rides were shown last, else a dish.
  z.object({
    kind: z.literal("select"),
    index: z.number().int().min(0).max(19).nullable(),
    pick: z.enum(["cheapest", "fastest"]).nullable(),
  }),
  // "Book it": the selected ride, through the booking card's own Book button.
  z.object({ kind: z.literal("ride.book") }),
  // "Book rides for four, one only for me": asks which they mean first.
  z.object({ kind: z.literal("ride.group"), members: z.number().int().min(2).max(10) }),
  // The answer to that question.
  z.object({ kind: z.literal("ride.group_mode"), mode: z.enum(["shared", "mine"]) }),
  z.object({ kind: z.literal("confirm") }),
  z.object({ kind: z.literal("cancel") }),
]);
export type AgentAction = z.infer<typeof actionSchema>;

/** App routes for each place chat can take the customer. */
export const ROUTES: Record<Extract<AgentAction, { kind: "navigate" }>["to"], string> = {
  cart: "/cart",
  orders: "/history",
  settings: "/profile/settings",
  security: "/profile/privacy",
  profile: "/profile",
  groups: "/food/group",
  help: "/profile/help",
  rewards: "/profile/rewards",
};
