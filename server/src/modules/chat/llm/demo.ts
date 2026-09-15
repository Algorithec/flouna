import type { Intent, LlmProvider } from "./types.js";

// Keyless intent extraction, and the floor the whole product stands on.
//
// This is not only a development convenience. It is what serves every request
// whenever no provider key is configured, a key expires, or the hosted model is
// unreachable, so its accuracy is the accuracy Flouna degrades to rather than a
// number nobody looks at. scripts/eval-intent.mjs measures it against the same
// labelled set the hosted models are measured against.
//
// Rules rather than a model because the cost is zero, the latency is zero, the
// behaviour is inspectable, and a rule cannot be talked out of its instructions
// by the message it is reading.

// Plural and possessive endings on dish and product names. Written once here
// because "order 2 dosas" and "cotton t shirts" were both classified
// out_of_scope purely for being plural.
const S = "(?:e?s)?";

const CUISINES = "chinese|indian|italian|mexican|thai|continental|mughlai|punjabi|south indian|north indian";
const DISHES = `biryani|pizza|burger|dosa|pasta|noodle|thali|paneer|samosa|idli|vada|paratha|roll|shawarma|momo|cake|ice ?cream|curry|fried rice|rice|sandwich|wrap|salad|soup|kebab|tikka|naan|chaat|pav bhaji|pulao|korma`;
// Words that describe a craving rather than name a dish. The hosted prompt
// requires these be kept as the item ("something spicy" -> "spicy"), and the
// rules now agree instead of flattening them to "popular dishes".
const MOODS = "spicy|sweet|healthy|light|cheesy|savoury|savory|tangy|creamy|comfort";

const FOOD_WORDS = new RegExp(
  `\\b(?:(?:${DISHES})${S}|${CUISINES}|${MOODS}|chicken|mutton|fish|egg|prawn|veg|tiffin|breakfast|lunch|dinner|brunch|snack${S}|dessert${S}|food|eat|hungry|meal${S}|craving|dhaba|restaurant)\\b`,
  "i",
);

// Transport asked for, as opposed to a place that happens to be mentioned.
//
// "office" used to live in this list, so "buy a office chair for 8000" matched
// rides before shop ever got a look and the customer was offered a taxi. A
// place name is not a request to travel; a vehicle or a travel verb is.
const RIDE_WORDS =
  /\b(ride|cab|taxi|auto|rickshaw|bike|uber|ola|rapido|transport|commute|pick me|pickup|drop me|take me|get me to|go to|travel to|reach)\b/i;

const SHOP_WORDS = new RegExp(
  `\\b(laptop${S}|smartphone${S}|phone${S}|mobile${S}|tablet${S}|earbud${S}|earphone${S}|headphone${S}|headset${S}|tws|earpod${S}|shoe${S}|sneaker${S}|t[ -]?shirt${S}|shirt${S}|jean${S}|dress${S}|clothing|watch${S}|smartwatch${S}|keyboard${S}|mouse|monitor${S}|charger${S}|powerbank${S}|speaker${S}|air ?fryer${S}|washing machine${S}|refrigerator${S}|fridge${S}|microwave${S}|television${S}|tv|chair${S}|table${S}|sofa${S}|furniture|mattress${S}|appliance${S}|gaming|buy|purchase|shopping|order online|electronics|fashion|gadget${S})\\b`,
  "i",
);

/**
 * Levenshtein distance, capped so a long comparison stops early.
 *
 * Here to catch typing rather than to be clever: "biriyani" and "piza" were
 * being routed out of scope for one wrong letter, and a customer who
 * misspells a dish is still asking for the dish.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      row.push(v);
      if (v < best) best = v;
    }
    // Every way of reaching this row already costs more than the caller cares
    // about, so no continuation can come back under the cap.
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * How far a word may be from a known one before it stops being a typo.
 *
 * Scaled by length, because one wrong letter in a four letter word is a much
 * bigger share of it than one wrong letter in nine.
 */
function typoTolerance(word: string): number {
  if (word.length >= 7) return 2;
  if (word.length >= 4) return 1;
  return 0;
}

/** The vocabulary a misspelling is allowed to be corrected to. */
const KNOWN_WORDS = `${DISHES}|${CUISINES}`.split("|").filter((w) => !w.includes(" "));

/**
 * Repairs words that are one or two letters from something we know.
 *
 * Applied only to the domain vocabulary, never to place names: a place we do
 * not hold cannot be corrected toward one we do without inventing a
 * destination the customer never asked for.
 */
function repairTypos(message: string): string {
  return message.replace(/\b[a-z]{4,}\b/gi, (word) => {
    // A capital in the middle of a sentence is usually a name, and a place we
    // do not hold must never be nudged toward a dish we do. "India" is one
    // letter from "indian", which turned a question about a prime minister
    // into a curry order.
    if (/^[A-Z]/.test(word)) return word;
    const lower = word.toLowerCase();
    if (KNOWN_WORDS.includes(lower)) return word;
    const tolerance = typoTolerance(lower);
    if (tolerance === 0) return word;
    let best: { word: string; distance: number } | null = null;
    for (const known of KNOWN_WORDS) {
      const d = editDistance(lower, known, tolerance);
      if (d <= tolerance && (!best || d < best.distance)) best = { word: known, distance: d };
    }
    return best ? best.word : word;
  });
}

/**
 * Products whose word is more often something else.
 *
 * "recommend a movie to watch" was answered with a shopping search for
 * watches. These count as products only when the message is also about
 * buying, which is the difference between the two senses.
 */
const AMBIGUOUS_PRODUCTS = /\b(watch|mouse|tablet|monitor)\b/i;
const PURCHASE_INTENT =
  /\b(buy|buying|purchase|shopping for|looking for|order online|price of|deal on|under\s*(?:₹|rs\.?)?\s*\d)\b/i;
// A qualifier nobody applies to the other sense of the word. Mice do not come
// in bluetooth, so "wireless mouse" needs no purchase verb to be a product,
// while "recommend a movie to watch" still does.
const PRODUCT_QUALIFIER =
  /\b(wireless|bluetooth|usb|mechanical|gaming|smart|digital|analog|inch|portable|rechargeable)\b/i;

const GREETING_WORDS =
  // No bare "help": it is how "help me with my physics homework" opens, and a
  // refusal misread as a greeting is still a wrong answer.
  /^(hi|hii+|hello|hey|good (morning|afternoon|evening)|thanks|thank you|namaste|what can you do|who are you|how do you work)\b/i;

const OUT_OF_SCOPE_REPLY =
  "I can help you order food, book rides, or shop. What would you like?";

/** Words after a number that make it a duration, a distance or a count, never a price. */
const NOT_MONEY = /^\s*(?:mins?|minutes?|hrs?|hours?|secs?|seconds?|days?|kms?|kilomet(?:er|re)s?|people|persons?|pax|pieces?|pcs?|plates?|items?|portions?|servings?|stars?)\b/i;

/**
 * Reads a stated price, in paise, or null.
 *
 * The earlier pattern took the first number of two or more digits and made
 * every word before it optional, with "within" counted as a budget word. So
 * "biryani within 35 minutes" was a ₹35 budget, "order 12 samosas" a ₹12
 * budget, and "biryani within 35 minutes under 300" took the 35 and ignored
 * the ₹300. None of it showed, because a budget used to be waived when nothing
 * fitted it, and a ₹35 budget fits nothing.
 *
 * A stated price is now enforced, which turns every such misreading into a
 * search that returns nothing. That settles the rule for anything ambiguous: a
 * limit missed shows a few extra options, a limit invented shows none, so an
 * unclear number is not a price. It counts only when marked as money, or
 * introduced by a word that means a ceiling, and never when a unit of time,
 * distance or quantity follows it.
 */
function parseBudget(message: string): number | null {
  for (const m of message.matchAll(/\d[\d,]*/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 10) continue;

    const before = message.slice(0, m.index);
    const after = message.slice(m.index! + m[0].length);
    if (NOT_MONEY.test(after)) continue;

    const markedBefore = /(?:₹|\brs\.?|\binr)\s*$/i.test(before);
    const markedAfter = /^\s*(?:rupees?\b|rs\b\.?|inr\b|\/-)/i.test(after);
    if (markedBefore || markedAfter) return n * 100;

    // Words that only ever introduce a ceiling.
    if (/\b(?:under|below|less than|max(?:imum)?|up\s?to|budget(?:\s+of)?)\s*$/i.test(before)) {
      return n * 100;
    }
    // Words that introduce a price as often as a count or a time: "chair for
    // 8000", but also "dinner for 10" or "within 30". Accepted only above the
    // point where a small number is far more likely to be something else.
    if (/\b(?:for|within|around|about)\s*$/i.test(before) && n >= 50) {
      return n * 100;
    }
  }
  return null;
}

/**
 * "within 35 minutes", "in 30 mins", "under an hour" → minutes, or null.
 *
 * A unit of time is required. Without one, "within 300" is as likely a price,
 * and reading it as a delivery limit would remove every slow kitchen for no
 * reason the customer gave.
 */
function extractMaxEtaMinutes(message: string): number | null {
  if (/\b(?:within|in|under|less than)\s+half\s+an?\s+hour\b/i.test(message)) return 30;
  if (/\b(?:within|in|under|less than)\s+(?:an?|one)\s+hour\b/i.test(message)) return 60;
  const m = message.match(
    /\b(?:within|in|under|less than|no more than|max(?:imum)?)\s+(\d{1,3})\s*(mins?|minutes?|hrs?|hours?)\b/i,
  );
  if (!m) return null;
  const n = Number(m[1]);
  const minutes = /^h/i.test(m[2]!) ? n * 60 : n;
  return minutes > 0 ? minutes : null;
}

/**
 * "don't want to wait more than 5 minutes", "pickup within 5 mins" → 5.
 *
 * Only the wait for the vehicle. "get me there in 30 minutes" limits the whole
 * trip, and reading it as a pickup limit would remove every ride that takes
 * longer than half an hour to reach the rider, which is not what was asked.
 * So a pickup or waiting word is required, not merely a number of minutes.
 */
function extractMaxPickupMinutes(message: string): number | null {
  const m =
    message.match(
      /\bwait(?:ing)?\s+(?:for\s+)?(?:more than|longer than|over|beyond|past)\s+(\d{1,3})\s*(?:mins?|minutes?)?\b/i,
    ) ??
    message.match(
      // "arrive" is deliberately absent: "arrive in 30 minutes" is as often
      // the destination as the vehicle, and an ambiguous word must not set a
      // limit that removes rides.
      /\b(?:pick\s?up|picked up|pick me up|reach me|get to me)\s+(?:in|within|under)\s+(\d{1,3})\s*(?:mins?|minutes?)\b/i,
    );
  const n = m?.[1] ? Number(m[1]) : null;
  return n && n > 0 ? n : null;
}

// What the user cares about most, inferred from their words.
function extractPriority(
  message: string,
): "price" | "rating" | "speed" | "balanced" {
  // Bare "good" counts. Somebody asking for "a good laptop" or "some good
  // desserts" is asking about quality, and "good morning" never reaches here
  // because the greeting rule answers first.
  if (
    /\b(top[- ]?rated|best|highest[- ]?rated|good|well[- ]?reviewed|quality|popular)\b/i.test(
      message,
    )
  )
    return "rating";
  if (
    /\b(fast(est)?|quick(ly|est)?|asap|hurry|soon|urgent(ly)?|immediately|right away|in a rush)\b/i.test(
      message,
    )
  )
    return "speed";
  if (/\b(cheap(est)?|budget|low(est)?[- ]?price|affordable|save money)\b/i.test(message))
    return "price";
  return "balanced";
}

function extractShop(message: string) {
  const itemMatch = message.match(
    new RegExp(
      `\\b(gaming laptop|laptop|smartphone|phone|mobile|tablet|earbud${S}|earphone${S}|headphone${S}|headset${S}|keyboard${S}|charger${S}|speaker${S}|shoe${S}|sneaker${S}|t[ -]?shirt${S}|shirt${S}|jean${S}|smartwatch|watch|air ?fryer|washing machine|refrigerator|fridge|microwave|television|tv|office chair|chair|table|sofa|mattress)\\b`,
      "i",
    ),
  );
  // Each family carries the plural too. Without it "running shoes" and "cotton
  // t shirts" matched the product but reported no category at all, so the
  // search fell back to every category at once.
  const inCategory = (alternatives: string) =>
    new RegExp(`\\b(?:${alternatives})\\b`, "i").test(message);
  const category = inCategory(
    `laptop${S}|smartphone${S}|phone${S}|mobile${S}|tablet${S}|earbud${S}|earphone${S}|headphone${S}|headset${S}|earpod${S}|keyboard${S}|mouse|charger${S}|powerbank${S}|speaker${S}|monitor${S}|watch${S}|smartwatch${S}|television${S}|tv|electronics|gaming`,
  )
    ? ("electronics" as const)
    : inCategory(
          `shoe${S}|sneaker${S}|t[ -]?shirt${S}|shirt${S}|jean${S}|dress${S}|clothing|fashion`,
        )
      ? ("fashion" as const)
      : inCategory(
            `air ?fryer${S}|washing machine${S}|refrigerator${S}|fridge${S}|microwave${S}|appliance${S}`,
          )
        ? ("appliances" as const)
        : inCategory(`chair${S}|table${S}|sofa${S}|furniture|mattress${S}|home`)
          ? ("home" as const)
          : ("any" as const);
  return {
    item: itemMatch?.[0]?.toLowerCase() ?? "products",
    budgetPaise: parseBudget(message),
    category,
    priority: extractPriority(message),
  };
}

function extractFood(message: string) {
  // Dishes first, then cuisines, then the mood words, so "spicy biryani"
  // reports the dish and "something spicy" still reports something.
  const itemMatch =
    message.match(new RegExp(`\\b(${DISHES})${S}\\b`, "i")) ??
    message.match(new RegExp(`\\b(${CUISINES})\\b`, "i")) ??
    message.match(new RegExp(`\\b(${MOODS})\\b`, "i"));
  // Meat names are the reliable signal. Vegetarian dishes have to be named
  // too: "paneer butter masala" was reported as "any", which then offered a
  // vegetarian customer whatever ranked highest.
  const dietary = /\b(non[- ]?veg|chicken|mutton|fish|egg|prawn|meat|beef|pork|keema)\b/i.test(
    message,
  )
    ? ("nonveg" as const)
    : /\b(veg(etarian)?|paneer|dal|aloo|gobi|mushroom|jain)\b/i.test(message)
      ? ("veg" as const)
      : ("any" as const);
  return {
    item: itemMatch?.[1]?.toLowerCase() ?? "popular dishes",
    budgetPaise: parseBudget(message),
    maxEtaMinutes: extractMaxEtaMinutes(message),
    dietary,
    priority: extractPriority(message),
  };
}

// "at 10pm", "at 10:30 pm", "at 22:00", "tonight at 9" → 24h "HH:mm".
// No match (or an unparseable time) → null, meaning "ride now".
function extractScheduleAt(message: string): string | null {
  const m = message.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else {
    if (hours > 23) return null;
    // A bare hour has to be read against the rest of the sentence. "tonight at
    // 9" was being booked for 09:00, twelve hours from what the rider asked
    // for, because only 1 to 7 were assumed to mean the evening.
    const evening = /\b(tonight|this evening|evening|night)\b/i.test(message);
    const morning = /\b(morning|breakfast|dawn)\b/i.test(message);
    const bareHour = m[2] === undefined;
    if (bareHour && !morning && hours >= 1 && hours <= (evening ? 11 : 7)) {
      hours += 12;
    }
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Strips a trailing time phrase so it cannot end up inside a place name. */
function withoutTime(place: string): string {
  return place.replace(/\s+(at\s+\d.*|tonight|this evening|tomorrow|now)\s*$/i, "").trim();
}

/**
 * Cuts a destination at the first limit the rider attached to it.
 *
 * The destination pattern reads everything after "to", so "cab to Gachibowli,
 * pickup within 4 mins" asked the geocoder for "gachibowli, pickup within 4
 * mins", and "to HITEC City under ₹300" for "HITEC City under". That was
 * already true, but a stated fare and a pickup limit are now things the engine
 * understands and a rider is invited to say, so leaving the destination to
 * swallow them would break the very request they make possible.
 *
 * Deliberately not cut at a full stop: "to St. Mary's Church" is a place. The
 * guide's own example ends its destination with "now", which is cut instead.
 */
function withoutConstraints(place: string): string {
  const cut = place.search(
    new RegExp(
      [
        String.raw`\s+(?:now|asap|immediately)\b`,
        String.raw`\s+(?:under|below|less than|within|max(?:imum)?|budget|up\s?to)\b`,
        String.raw`\s*(?:₹|\brs\.?\s*\d|\binr\b)`,
        String.raw`,?\s*\b(?:pick\s?up|picked up|pick me up|don'?t|do not|need to|want to|wait(?:ing)?|arrive|reach by)\b`,
      ].join("|"),
      "i",
    ),
  );
  const kept = cut === -1 ? place : place.slice(0, cut);
  return (
    kept
      // "I need to go to HITEC City" is matched from its first "to", the one
      // in "need to", which captures "go to HITEC City". Matching the last
      // "to" instead would turn "take me to Banjara Hills to meet a friend"
      // into a trip to "meet a friend", so the travel verb is stripped from
      // the front of what was captured instead. Requires a space after the
      // verb, so a place such as "Gokul Chat" is left alone.
      .replace(/^(?:go|going|get|getting|travel|head|move|come|reach)\s+(?:to\s+)?/i, "")
      .replace(/[\s,.'-]+$/, "")
      .trim()
  );
}

function extractRide(message: string) {
  const dropMatch = message.match(
    /(?:\bto|towards|till|drop (?:me )?(?:at|to))\s+([a-z0-9 ,.'-]{3,60})/i,
  );
  // "auto from Ameerpet to Kukatpally" names both ends. The pickup was simply
  // never read, so every such ride started from wherever the device was.
  const pickupMatch = message.match(
    /(?:\bfrom|pick (?:me )?up (?:from|at))\s+([a-z0-9 ,.'-]{3,60}?)(?=\s+(?:to|and|towards|till)\b|$)/i,
  );
  let drop = dropMatch?.[1] ? withoutTime(withoutConstraints(dropMatch[1])) : "";
  // Hinglish word order puts the destination last with no preposition at all
  // ("cab book karo Hitech City"), which the "to" pattern cannot see.
  if (!drop) {
    const trailing = message.match(
      /\b(?:karo|kar do|chahiye|chaiye|bhej|book)\s+([a-z0-9 ,.'-]{3,60})$/i,
    );
    if (trailing?.[1]) drop = withoutTime(withoutConstraints(trailing[1]));
  }
  const vehicle = /\bbike\b/i.test(message)
    ? ("bike" as const)
    : /\b(auto|rickshaw)\b/i.test(message)
      ? ("auto" as const)
      : /\b(cab|taxi|car)\b/i.test(message)
        ? ("cab" as const)
        : ("any" as const);
  return {
    pickup: pickupMatch?.[1] ? withoutTime(pickupMatch[1]) : null,
    drop: drop || "your destination",
    vehicle,
    budgetPaise: parseBudget(message),
    maxPickupMinutes: extractMaxPickupMinutes(message),
    priority: extractPriority(message),
    scheduleAt: extractScheduleAt(message),
  };
}

export class DemoProvider implements LlmProvider {
  name = "demo";

  async extractIntent(original: string): Promise<Intent> {
    const first = classify(original);
    if (first.domain !== "out_of_scope") return first;

    // Only now is typing considered, and only to rescue a message we were
    // about to refuse.
    //
    // Repairing everything up front looked tidier and was much worse: "ride"
    // is one letter from "rice" and "India" one from "indian", so
    // "cheapest ride to Madhapur" became a lunch order and a question about a
    // prime minister became a curry. Correcting a message that already
    // classified can only ever spoil it, so the repair sits behind the
    // refusal, where the worst case is that it changes nothing.
    const repaired = repairTypos(original);
    if (repaired === original) return first;
    const second = classify(repaired);
    return second.domain === "out_of_scope" ? first : second;
  }
}

/** The rules themselves, over whatever text they are handed. */
function classify(message: string): Intent {
  {
    if (GREETING_WORDS.test(message.trim())) {
      return {
        domain: "greeting",
        reply: "Hey! Ask me for food or a ride and I'll find you the best deal.",
      };
    }

    const wantsRide = RIDE_WORDS.test(message);
    const wantsFood = FOOD_WORDS.test(message);
    // A word that is more often a verb counts as a product only when the
    // message is also about buying. Otherwise "recommend a movie to watch" is
    // answered with a search for watches.
    const shopMatch = SHOP_WORDS.test(message);
    const onlyAmbiguous =
      shopMatch &&
      AMBIGUOUS_PRODUCTS.test(message) &&
      !SHOP_WORDS.test(message.replace(AMBIGUOUS_PRODUCTS, " "));
    const wantsShop =
      (shopMatch && !onlyAmbiguous) ||
      (onlyAmbiguous &&
        (PURCHASE_INTENT.test(message) || PRODUCT_QUALIFIER.test(message)));

    // Both in one message → combo ("order biryani and book a cab home").
    if (wantsRide && wantsFood) {
      return {
        domain: "combo",
        reply: "On it, sorting out both your food and your ride.",
        food: extractFood(message),
        ride: extractRide(message),
      };
    }

    // Shop is tested before ride and food because its nouns are the specific
    // ones. A shopping list can mention a place or a material without being a
    // request to travel or to eat.
    if (wantsShop && !wantsRide) {
      return {
        domain: "shop",
        reply: "On it, comparing prices across stores for you.",
        shop: extractShop(message),
      };
    }

    if (wantsRide) {
      return {
        domain: "ride",
        reply: "On it, comparing ride options for you.",
        ride: extractRide(message),
      };
    }

    if (wantsFood) {
      return {
        domain: "food",
        reply: "Got it, finding the best deal for you.",
        food: extractFood(message),
      };
    }

    if (wantsShop) {
      return {
        domain: "shop",
        reply: "On it, comparing prices across stores for you.",
        shop: extractShop(message),
      };
    }

    return { domain: "out_of_scope", reply: OUT_OF_SCOPE_REPLY };
  }
}
