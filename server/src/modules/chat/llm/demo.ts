import type { Intent, LlmProvider } from "./types.js";

// Keyless fallback so the whole product runs without any LLM account.
// Simple keyword rules — replaced in production by Anthropic/DeepSeek.
const FOOD_WORDS =
  /\b(biryani|pizza|burger|dosa|pasta|noodles|thali|paneer|chicken|veg|tiffin|breakfast|lunch|dinner|snack|dessert|cake|ice ?cream|samosa|idli|paratha|roll|shawarma|momos|food|eat|hungry|spicy|sweet|healthy|cheesy|meal|craving)\b/i;
const RIDE_WORDS =
  /\b(ride|cab|taxi|auto|bike|uber|ola|rapido|drop|pickup|pick me|airport|station|office|go to|take me)\b/i;
const SHOP_WORDS =
  /\b(laptop|phone|mobile|earbuds|headphones|tws|shoes|sneakers|tshirt|t-shirt|shirt|clothing|watch|smartwatch|air ?fryer|appliance|gaming|buy|shopping|electronics|fashion|gadget)\b/i;
const GREETING_WORDS = /^(hi|hii+|hello|hey|good (morning|afternoon|evening)|thanks|thank you|namaste)\b/i;

const OUT_OF_SCOPE_REPLY =
  "I can help you order food, book rides, or shop. What would you like?";

function parseBudget(message: string): number | null {
  // Handles ₹300, Rs 1,29,900, under 70000, etc. (rupees → paise).
  const m = message.match(
    /(?:under|below|less than|within|max|upto|up to|budget)?\s*(?:₹|rs\.?|inr)?\s*([\d,]{2,8})/i,
  );
  const n = m?.[1] ? Number(m[1].replace(/,/g, "")) : null;
  return n && n >= 10 ? n * 100 : null;
}

function extractShop(message: string) {
  const itemMatch = message.match(
    /\b(gaming laptop|laptop|phone|mobile|earbuds|headphones|shoes|sneakers|t-?shirt|smartwatch|watch|air ?fryer)\b/i,
  );
  const category = /\b(laptop|phone|earbuds|headphones|watch|smartwatch|electronics|gaming)\b/i.test(message)
    ? ("electronics" as const)
    : /\b(shoes|sneakers|t-?shirt|shirt|clothing|fashion)\b/i.test(message)
      ? ("fashion" as const)
      : /\b(air ?fryer|appliance|kitchen)\b/i.test(message)
        ? ("appliances" as const)
        : ("any" as const);
  return {
    item: itemMatch?.[0]?.toLowerCase() ?? "products",
    budgetPaise: parseBudget(message),
    category,
    priority: extractPriority(message),
  };
}

// What the user cares about most, inferred from their words.
function extractPriority(
  message: string,
): "price" | "rating" | "speed" | "balanced" {
  if (/\b(top[- ]?rated|best|highest[- ]?rated|good reviews?|quality)\b/i.test(message))
    return "rating";
  if (/\b(fast(est)?|quick(est)?|asap|hurry|soon|in a rush)\b/i.test(message))
    return "speed";
  if (/\b(cheap(est)?|budget|low(est)?[- ]?price|affordable|save money)\b/i.test(message))
    return "price";
  return "balanced";
}

function extractFood(message: string) {
  const itemMatch = message.match(
    /\b(biryani|pizza|burger|dosa|pasta|noodles|thali|paneer|samosa|idli|paratha|roll|shawarma|momos|cake|ice ?cream)\b/i,
  );
  const dietary = /\bveg(etarian)?\b/i.test(message)
    ? ("veg" as const)
    : /\b(non[- ]?veg|chicken|mutton|fish|egg)\b/i.test(message)
      ? ("nonveg" as const)
      : ("any" as const);
  return {
    item: itemMatch?.[0]?.toLowerCase() ?? "popular dishes",
    budgetPaise: parseBudget(message),
    maxEtaMinutes: null,
    dietary,
    priority: extractPriority(message),
  };
}

// "at 10pm", "at 10:30 pm", "at 22:00", "tonight at 10" → 24h "HH:mm".
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
    // Bare "at 10" defaults to evening (the common booking phrasing);
    // explicit 24h times like "at 22:00" pass through unchanged.
    if (hours >= 1 && hours <= 7 && m[2] === undefined) hours += 12;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function extractRide(message: string) {
  const dropMatch = message.match(/(?:to|towards|till)\s+([a-z0-9 ,.'-]{3,60})/i);
  // Keep a trailing time phrase out of the destination ("airport at 10pm").
  const drop = dropMatch?.[1]?.replace(/\s+at\s+\d.*$/i, "").trim();
  const vehicle = /bike/i.test(message)
    ? ("bike" as const)
    : /auto/i.test(message)
      ? ("auto" as const)
      : /cab|taxi|car/i.test(message)
        ? ("cab" as const)
        : ("any" as const);
  return {
    pickup: null,
    drop: drop || "your destination",
    vehicle,
    priority: extractPriority(message),
    scheduleAt: extractScheduleAt(message),
    budgetPaise: null,
    maxPickupMinutes: null,
  };
}

export class DemoProvider implements LlmProvider {
  name = "demo";

  async extractIntent(message: string): Promise<Intent> {
    if (GREETING_WORDS.test(message.trim())) {
      return {
        domain: "greeting",
        reply: "Hey! Ask me for food or a ride and I'll find you the best deal.",
      };
    }

    // Both in one message → combo ("order biryani and book a cab home").
    if (RIDE_WORDS.test(message) && FOOD_WORDS.test(message)) {
      return {
        domain: "combo",
        reply: "On it, sorting out both your food and your ride.",
        food: extractFood(message),
        ride: extractRide(message),
      };
    }

    if (RIDE_WORDS.test(message) && !FOOD_WORDS.test(message)) {
      return {
        domain: "ride",
        reply: "On it, comparing ride options for you.",
        ride: extractRide(message),
      };
    }

    if (FOOD_WORDS.test(message)) {
      return {
        domain: "food",
        reply: "Got it, finding the best deal for you.",
        food: extractFood(message),
      };
    }

    if (SHOP_WORDS.test(message)) {
      return {
        domain: "shop",
        reply: "On it, comparing prices across stores for you.",
        shop: extractShop(message),
      };
    }

    return { domain: "out_of_scope", reply: OUT_OF_SCOPE_REPLY };
  }
}
