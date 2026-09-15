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

function parseBudget(message: string): number | null {
  // Handles ₹300, Rs 1,29,900, under 70000, etc. (rupees → paise).
  const m = message.match(
    /(?:under|below|less than|within|max|upto|up to|budget|for)?\s*(?:₹|rs\.?|inr)?\s*([\d,]{2,8})/i,
  );
  const n = m?.[1] ? Number(m[1].replace(/,/g, "")) : null;
  return n && n >= 10 ? n * 100 : null;
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

function extractRide(message: string) {
  const dropMatch = message.match(
    /(?:\bto|towards|till|drop (?:me )?(?:at|to))\s+([a-z0-9 ,.'-]{3,60})/i,
  );
  // "auto from Ameerpet to Kukatpally" names both ends. The pickup was simply
  // never read, so every such ride started from wherever the device was.
  const pickupMatch = message.match(
    /(?:\bfrom|pick (?:me )?up (?:from|at))\s+([a-z0-9 ,.'-]{3,60}?)(?=\s+(?:to|and|towards|till)\b|$)/i,
  );
  let drop = dropMatch?.[1] ? withoutTime(dropMatch[1]) : "";
  // Hinglish word order puts the destination last with no preposition at all
  // ("cab book karo Hitech City"), which the "to" pattern cannot see.
  if (!drop) {
    const trailing = message.match(
      /\b(?:karo|kar do|chahiye|chaiye|bhej|book)\s+([a-z0-9 ,.'-]{3,60})$/i,
    );
    if (trailing?.[1]) drop = withoutTime(trailing[1]);
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
