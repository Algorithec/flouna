import type { AgentAction, Target } from "./actions.js";

// Reads an instruction into an action, or returns null when the message is
// not an instruction (a search, a question, a greeting), so it goes on to the
// usual recommendation flow.
//
// Deterministic on purpose: the same words always mean the same action, it
// works with no model configured, and nothing in a message can widen what it
// is allowed to do. Phrasing it does not recognise falls through to search
// rather than being guessed at.

const WORD_NUMBERS: Record<string, number> = {
  one: 1, a: 1, an: 1, single: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const ORDINALS: Record<string, number> = {
  first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4,
  sixth: 5, "6th": 5, last: -1,
};

function numberFrom(word: string | undefined): number | null {
  if (!word) return null;
  if (/^\d{1,3}$/.test(word)) return Number(word);
  return WORD_NUMBERS[word] ?? null;
}

/** Which item the rest of the sentence points at. */
function targetFrom(rest: string): Target {
  const ord = rest.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|last)\b(?:\s+(?:one|option|dish|item|result))?/);
  if (ord && ORDINALS[ord[1]!] !== -1) return { by: "position", index: ORDINALS[ord[1]!]! };
  const num = rest.match(/\b(?:option|number|no\.?|item|#)\s*(\d{1,2})\b/);
  if (num) return { by: "position", index: Math.max(0, Number(num[1]) - 1) };
  // What is left once filler is taken out is a name, if anything.
  const name = rest
    .replace(/\b(to|into|in|from|out of|my|the|a|an|cart|basket|please|too|also|as well|one more|another|of|those|these|it|that|this|them|one|same|again|for me|only|just|now|items?|dish(es)?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length >= 3) return { by: "name", text: name };
  return { by: "last" };
}

const LEADING_QTY = /^(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|couple of)\b\s*(?:x\b|more\b|of\b|plates?\b|portions?\b)?\s*/;

/**
 * Quantity stated at the start of an add instruction ("add 2 of those", "add
 * two biryanis"). Only there: a number later on is part of a dish's name
 * ("chicken 65") or a position ("option 3").
 */
function splitQty(rest: string): { qty: number; rest: string } {
  const m = rest.match(LEADING_QTY);
  if (!m) return { qty: 1, rest };
  const n = numberFrom(m[1]!.replace(/^(a )?couple of$/, "couple"));
  return { qty: n && n >= 1 && n <= 20 ? n : 1, rest: rest.slice(m[0].length) };
}

const LANG_WORDS: Record<string, AgentAction & { kind: "settings.language" }> = Object.fromEntries(
  (
    [
      ["english", "en"], ["hindi", "hi"], ["marathi", "mr"], ["kannada", "kn"], ["tamil", "ta"], ["telugu", "te"],
    ] as const
  ).map(([w, lang]) => [w, { kind: "settings.language", lang }]),
);

const TOGGLES: [RegExp, Extract<AgentAction, { kind: "settings.toggle" }>["setting"]][] = [
  [/\b(money|payment|refund) (emails?|updates?|notifications?)\b/, "emailMoneyUpdates"],
  [/\btips?( emails?)?\b/, "emailTips"],
  [/\bemail (updates?|notifications?)|\bemails?\b/, "emailUpdates"],
  [/\b(smart )?suggestions?\b/, "smartSuggestions"],
  [/\b(share|sharing) (my )?location|\blocation sharing\b/, "shareLocation"],
  [/\bactivity( status)?\b|\bonline status\b/, "activityStatus"],
];

export function parseInstruction(message: string): AgentAction | null {
  const t = message
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[.!?,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;

  // Answers to a question chat asked.
  if (/^(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|go ahead|do it|haan|ha|please do)( please| do it| go ahead)?$/.test(t)) {
    return { kind: "confirm" };
  }
  if (/^(no|nope|nah|cancel|don't|do not|stop|never mind|nevermind|leave it)( it| that| thanks)?$/.test(t)) {
    return { kind: "cancel" };
  }

  // Group orders. Checked before "add", since "order one biryani only for me"
  // inside a group request is part of it, not a separate add.
  const group = t.match(/\b(create|start|make|open|set up|setup|begin)\b.*\bgroup( order)?\b/);
  if (group) {
    const m = t.match(/\bfor (\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)( members?| people| persons?| friends?| of us)?\b/);
    const members = numberFrom(m?.[1]);
    const withMyItems = /\b(only for me|just for me|for me only|for myself|my items|my cart|what i (added|have))\b/.test(t);
    return { kind: "group.create", members: members && members >= 2 && members <= 50 ? members : null, withMyItems };
  }
  if (/\b(show|open|see|view)\b.*\b(my )?group( order)?\b/.test(t)) return { kind: "group.show" };

  // Cart.
  if (/\b(clear|empty|reset)\b.*\b(cart|basket)\b/.test(t)) return { kind: "cart.clear" };
  if (/\b(show|open|see|view|what'?s in|whats in|check)\b.*\b(cart|basket)\b/.test(t) || /^(my )?(cart|basket)$/.test(t)) {
    return { kind: "cart.show" };
  }
  if (/\b(check ?out|place (the |my )?order|pay now|proceed to pay(ment)?)\b/.test(t)) return { kind: "checkout" };

  const add = t.match(/^(?:please |can you |could you )?(add|put|include|get me|i'?ll take|i'?ll have|order)\b(.*)$/);
  if (add) {
    const rest = add[2]!.trim();
    // "order biryani" is a request to find biryani, not to add a named item
    // nobody has seen. Only treat "order" as add when it points back at
    // something ("order it", "order the second one").
    if (add[1] === "order" && !/\b(it|that|this|them|those|second|third|first|option|same)\b/.test(rest)) return null;
    const { qty, rest: what } = splitQty(rest);
    if (/\b(another|one more|same again)\b/.test(what) && !/\b(option|first|second|third)\b/.test(what)) {
      return { kind: "cart.add", target: { by: "last" }, qty };
    }
    return { kind: "cart.add", target: targetFrom(what), qty };
  }

  const remove = t.match(/^(?:please )?(remove|delete|take out|drop|cancel)\b(.*)$/);
  // Not the cart: "cancel my order" belongs to the order screen and its
  // cancellation terms, and budgets, accounts and profiles to their own rules
  // below.
  const notCart = /\b(group|order|ride|booking|subscription|budget|account|profile|password|sessions?)\b/;
  if (remove && !notCart.test(remove[2]!) && /\b(cart|basket|it|that|this|them|first|second|third|last|option|\w{3,})\b/.test(remove[2]!)) {
    return { kind: "cart.remove", target: targetFrom(remove[2]!.trim()) };
  }

  const qty = t.match(/^(?:make|change|set|update)\s+(.*?)\s*(?:to|=)\s*(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (qty) {
    const n = qty[2] === "zero" ? 0 : numberFrom(qty[2]);
    if (n !== null && n <= 20) return { kind: "cart.set_qty", target: targetFrom(qty[1]!), qty: n };
  }

  // Settings.
  const lang = t.match(/\b(change|switch|set|use|speak|talk|reply)\b.*\b(english|hindi|marathi|kannada|tamil|telugu)\b/);
  if (lang) return LANG_WORDS[lang[2]!]!;
  if (/\b(dark mode|dark theme|night mode)\b/.test(t) && /\b(turn on|switch|enable|use|set|change|go)\b/.test(t)) return { kind: "settings.theme", theme: "dark" };
  if (/\b(light mode|light theme|day mode)\b/.test(t) || (/\bdark mode\b/.test(t) && /\b(turn off|disable)\b/.test(t))) {
    return { kind: "settings.theme", theme: "light" };
  }

  const budget = t.match(/\b(?:weekly |food )?budget\b.*?(?:to|of|at)?\s*(?:₹|rs\.?|inr)?\s*(\d{3,6})\b/);
  if (budget && /\b(set|change|make|update|put)\b/.test(t)) return { kind: "settings.budget", weeklyRupees: Number(budget[1]) };
  if (/\b(remove|clear|delete|turn off|disable|no)\b.*\bbudget\b/.test(t)) return { kind: "settings.budget", weeklyRupees: null };

  if (/\bprofile\b/.test(t) && /\b(private|hide|hidden|nobody|no one|noone)\b/.test(t)) return { kind: "settings.visibility", value: "nobody" };
  if (/\bprofile\b/.test(t) && /\b(contacts|friends) only\b|\bonly (my )?(contacts|friends)\b/.test(t)) return { kind: "settings.visibility", value: "contacts" };
  if (/\bprofile\b/.test(t) && /\b(public|everyone|visible to all)\b/.test(t)) return { kind: "settings.visibility", value: "everyone" };

  const on = /\b(turn on|switch on|enable|start|allow|show)\b/.test(t);
  const off = /\b(turn off|switch off|disable|stop|mute|don't send|dont send|no more|hide)\b/.test(t);
  if (on !== off) {
    for (const [re, setting] of TOGGLES) if (re.test(t)) return { kind: "settings.toggle", setting, on };
  }

  // Things that need the customer's own hand.
  if (/\b(two[- ]factor|2fa|biometric|fingerprint|face id|password|delete (my )?account|log ?out|sign ?out|sessions?)\b/.test(t)) {
    return { kind: "navigate", to: "security" };
  }
  const nav = t.match(/\b(open|go to|take me to|show( me)?)\b.*\b(orders?|order history|settings|profile|rewards|offers|help|support|groups?)\b/);
  if (nav) {
    const w = nav[3]!;
    const to = w.startsWith("order") ? "orders" : w === "offers" ? "rewards" : w === "support" ? "help" : w.startsWith("group") ? "groups" : (w as "settings" | "profile" | "rewards" | "help");
    return { kind: "navigate", to };
  }

  return null;
}
