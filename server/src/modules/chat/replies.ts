// The chat's own sentences, each with a code the app translates
// (`chat.r.<code>` in its dictionaries), so a reader who chose Telugu is not
// answered in English. The English stays the reply for anything that does not
// know the codes, and a hosted model's own words carry no code at all.

export const REPLY_CODES = [
  "greeting",
  "combo",
  "shop",
  "ride",
  "food",
  "outOfScope",
  "empty",
  "tooLong",
  "foodNotFound",
  "shopNotFound",
  "foodOverPrice",
  "foodOverTime",
  "rideOverPrice",
  "rideOverPickup",
  "rideOverTrip",
] as const;
export type ReplyCode = { code: (typeof REPLY_CODES)[number]; params?: Record<string, string> };

/** A reply in English and as a code for the reader's language. */
export type Said = { reply: string; replyCode: ReplyCode };

/** The sentences that never change, written once for the rules and the firewall alike. */
export const FIXED_REPLIES = {
  greeting: "Hey! Ask me for food or a ride and I'll find you the best deal.",
  combo: "On it, sorting out both your food and your ride.",
  shop: "On it, comparing prices across stores for you.",
  ride: "On it, comparing ride options for you.",
  food: "Got it, finding the best deal for you.",
  outOfScope: "I can help you order food, book rides, or shop. What would you like?",
  empty: "Type what you'd like, food or a ride?",
  tooLong: 'That\'s a bit long for me, try a short request like "biryani under ₹300".',
} as const satisfies Partial<Record<ReplyCode["code"], string>>;

/**
 * The code for a reply that is one of the fixed sentences, whoever chose it.
 * Anything else, a model's own wording included, gets none and is shown as
 * written.
 */
export function codeForReply(reply: string): ReplyCode | undefined {
  const hit = Object.entries(FIXED_REPLIES).find(([, text]) => text === reply);
  return hit ? { code: hit[0] as ReplyCode["code"] } : undefined;
}

export function foodNotFound(item: string): Said {
  return {
    reply: `I couldn't find "${item}" near you right now, try biryani, pizza, dosa, or a thali?`,
    replyCode: { code: "foodNotFound", params: { item } },
  };
}

export function shopNotFound(item: string): Said {
  return {
    reply: `I couldn't find "${item}" right now, try a laptop, earbuds, shoes, or a smartwatch?`,
    replyCode: { code: "shopNotFound", params: { item } },
  };
}
