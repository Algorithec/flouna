// Price-intelligence & timing engine.
// Primary: learned hour-of-day patterns from observed prices (priceHistory).
// Fallback (cold start): rule-based meal-window / commute-surge heuristics.

import { predictFromHistory } from "./priceHistory.service.js";
import type { DecisionContext } from "./context.service.js";
import { istHour, istStartOfDay } from "../../lib/istTime.js";

/**
 * Every sentence the advisor can say, as a code the app translates (`adv.m.<code>`
 * in its dictionaries). `minutes` arrives as a number of minutes and the app
 * writes it in the reader's units.
 */
export const ADVICE_CODES = [
  "foodLiveLunch",
  "foodLiveSnack",
  "foodLiveDinner",
  "foodSoonLunch",
  "foodSoonSnack",
  "foodSoonDinner",
  "foodNone",
  "rideEasing",
  "ridePeak",
  "rideOffPeak",
  "historyWaitFood",
  "historyWaitRide",
  "historyNow",
  "foodHeavyRain",
  "foodRain",
  "rideHeavyRain",
  "rideRain",
] as const;
export type AdviceCode = { code: (typeof ADVICE_CODES)[number]; params?: Record<string, string> };

export type Advice = {
  action: "order_now" | "wait";
  // In English; `code` is the same sentence for the app to put in the reader's language.
  message: string;
  code?: AdviceCode;
  // "history" once we have enough observed data, else "rules"
  source?: "history" | "rules";
  // present only for "wait"
  expectedSavingPaise?: number;
  waitMinutes?: number;
  // A short context note layered on top (e.g. weather) — additive, never
  // overrides the timing call.
  contextNote?: string;
  noteCode?: AdviceCode;
};

type FoodWindow = {
  label: string;
  live: AdviceCode["code"];
  soon: AdviceCode["code"];
  startHour: number; // inclusive
  endHour: number; // exclusive
  savingPaise: number;
};

// Typical platform promo windows (IST).
const FOOD_WINDOWS: FoodWindow[] = [
  { label: "lunch-hour deal", live: "foodLiveLunch", soon: "foodSoonLunch", startHour: 12, endHour: 15, savingPaise: 4000 },
  { label: "evening snack offer", live: "foodLiveSnack", soon: "foodSoonSnack", startHour: 16, endHour: 18, savingPaise: 2500 },
  { label: "dinner-time offer", live: "foodLiveDinner", soon: "foodSoonDinner", startHour: 20, endHour: 23, savingPaise: 10000 },
];

const MAX_WORTH_WAITING_MINUTES = 120;

// The next time it is `hour` o'clock in India.
//
// The hour above is read on the rider's clock, so the target has to be built
// on the same one. Left as setHours it used the host's, and on a UTC machine
// the two disagreed by five and a half hours: the code knew it was seven in
// the evening and still worked out the wait to eight as if it were half past
// one in the afternoon.
function minutesUntilHour(now: Date, hour: number): number {
  let target = new Date(istStartOfDay(now).getTime() + hour * 3_600_000);
  if (target <= now) target = new Date(target.getTime() + 24 * 3_600_000);
  return Math.round((target.getTime() - now.getTime()) / 60_000);
}

export function adviseFoodByRules(now: Date = new Date()): Advice {
  const hour = istHour(now);

  const active = FOOD_WINDOWS.find((w) => hour >= w.startHour && hour < w.endHour);
  if (active) {
    return {
      action: "order_now",
      message: `Good timing, the ${active.label} is live right now. Prices are at their best.`,
      code: { code: active.live },
    };
  }

  // Closest upcoming window worth waiting for.
  const upcoming = FOOD_WINDOWS.map((w) => ({
    window: w,
    inMinutes: minutesUntilHour(now, w.startHour),
  }))
    .filter((u) => u.inMinutes <= MAX_WORTH_WAITING_MINUTES)
    .sort((a, b) => a.inMinutes - b.inMinutes)[0];

  if (upcoming) {
    const rupees = Math.round(upcoming.window.savingPaise / 100);
    return {
      action: "wait",
      message: `Flat ₹${rupees} off expected with the ${upcoming.window.label} in about ${formatWait(upcoming.inMinutes)}. Order now, or wait and save?`,
      code: { code: upcoming.window.soon, params: { rupees: String(rupees), minutes: String(upcoming.inMinutes) } },
      expectedSavingPaise: upcoming.window.savingPaise,
      waitMinutes: upcoming.inMinutes,
    };
  }

  return {
    action: "order_now",
    message: "No better offer window coming up soon, now is a fine time to order.",
    code: { code: "foodNone" },
  };
}

// Commute surge windows: fares typically elevated, easing afterwards.
const RIDE_SURGE = [
  { startHour: 8, endHour: 11, dropPaise: 4000 },
  { startHour: 17, endHour: 21, dropPaise: 5000 },
];

export function adviseRideByRules(now: Date = new Date()): Advice {
  const hour = istHour(now);
  const surge = RIDE_SURGE.find((s) => hour >= s.startHour && hour < s.endHour);

  if (surge) {
    const minutesLeft = minutesUntilHour(now, surge.endHour);
    if (minutesLeft <= 45) {
      const rupees = Math.round(surge.dropPaise / 100);
      return {
        action: "wait",
        message: `Peak-hour pricing is easing in about ${formatWait(minutesLeft)}, fares may drop around ₹${rupees}.`,
        code: { code: "rideEasing", params: { rupees: String(rupees), minutes: String(minutesLeft) } },
        expectedSavingPaise: surge.dropPaise,
        waitMinutes: minutesLeft,
      };
    }
    return {
      action: "order_now",
      message:
        "It's peak commute time, fares are elevated everywhere, and waiting won't help for a while. Booking now is reasonable.",
      code: { code: "ridePeak" },
    };
  }

  return {
    action: "order_now",
    message: "Off-peak right now, fares are at their lowest. Good time to book.",
    code: { code: "rideOffPeak" },
  };
}

function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

type Note = { contextNote: string; noteCode: AdviceCode };

// Weather context layered onto food advice: when it's wet, in-app delivery is
// the comfortable call and delivery times run a little longer.
function foodContextNote(ctx?: DecisionContext): Note | undefined {
  if (!ctx) return undefined;
  const w = ctx.weather;
  if (w.condition === "heavy_rain")
    return { contextNote: "It's pouring out, delivery may run a bit slow, but you stay dry by ordering in.", noteCode: { code: "foodHeavyRain" } };
  if (w.condition === "rain" || (w.rainChance ?? 0) >= 0.5)
    return { contextNote: "Rain about, a good time to order in rather than head out.", noteCode: { code: "foodRain" } };
  return undefined;
}

// Weather context layered onto ride advice: rain drives demand and surge.
function rideContextNote(ctx?: DecisionContext): Note | undefined {
  if (!ctx) return undefined;
  const w = ctx.weather;
  if (w.condition === "heavy_rain")
    return { contextNote: "Heavy rain, rides are in high demand and fares are surging. Book early if you must travel.", noteCode: { code: "rideHeavyRain" } };
  if (w.condition === "rain" || (w.rainChance ?? 0) >= 0.5)
    return { contextNote: "Rain expected, fares tend to rise and cabs get scarce. Booking sooner is safer.", noteCode: { code: "rideRain" } };
  return undefined;
}

// ---- History-first entry points (used by routes) ----
// Try learned patterns; fall back to rules until enough data accumulates.
// An optional DecisionContext layers a weather note on top of the timing call.

export async function adviseFood(
  dishKey: string | null,
  now: Date = new Date(),
  ctx?: DecisionContext,
): Promise<Advice> {
  const note = foodContextNote(ctx);
  if (dishKey) {
    const learned = await predictFromHistory("food", dishKey, now);
    if (learned) return { ...learned, ...note };
  }
  return { ...adviseFoodByRules(now), source: "rules", ...note };
}

export async function adviseRide(
  vehicleKey: string | null,
  now: Date = new Date(),
  ctx?: DecisionContext,
): Promise<Advice> {
  const note = rideContextNote(ctx);
  if (vehicleKey) {
    const learned = await predictFromHistory("ride", vehicleKey, now);
    if (learned) return { ...learned, ...note };
  }
  return { ...adviseRideByRules(now), source: "rules", ...note };
}
