// Decision Intelligence — Faculty 3: Context awareness.
//
// Gathers the *situation* a decision is being made in — time of day, weather,
// and location — into one compact DecisionContext. The decision core and the
// proactive predictor read this so a recommendation knows "it's raining at
// 8:55am near the user", not just "here are four ride fares".
//
// Works fully offline: weather comes from keyless Open-Meteo with a
// deterministic seasonal fallback, so context is always available even with no
// network and no keys (the rest of the app's demo-first contract).

import { istHour, istYearMonth } from "../../lib/istTime.js";

export type TimeOfDay =
  | "early_morning" // 5–8
  | "morning" // 8–11
  | "midday" // 11–15
  | "afternoon" // 15–17
  | "evening" // 17–21
  | "night" // 21–24
  | "late_night"; // 0–5

export type Weather = {
  condition: "clear" | "clouds" | "rain" | "heavy_rain" | "unknown";
  temperatureC: number | null;
  // Probability of precipitation in the next hour, 0..1 (null when unknown).
  rainChance: number | null;
  source: "live" | "offline";
};

export type DecisionContext = {
  now: Date;
  hour: number;
  timeOfDay: TimeOfDay;
  isPeakCommute: boolean; // 8 to 11 or 17 to 21
  isMealWindow: boolean; // typical lunch/dinner ordering windows
  weather: Weather;
  // True when conditions make a ride meaningfully more desirable / surge likely.
  rideDemandLikely: boolean;
};

// Hyderabad — our demo city centre; used when the caller gives no coords.
const DEFAULT_LAT = 17.43;
const DEFAULT_LNG = 78.4;

export function timeOfDayFor(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 8) return "early_morning";
  if (hour >= 8 && hour < 11) return "morning";
  if (hour >= 11 && hour < 15) return "midday";
  if (hour >= 15 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  if (hour >= 21) return "night";
  return "late_night";
}

function isPeak(hour: number): boolean {
  return (hour >= 8 && hour < 11) || (hour >= 17 && hour < 21);
}

function isMeal(hour: number): boolean {
  return (hour >= 12 && hour < 15) || (hour >= 20 && hour < 23);
}

// Deterministic offline weather: monsoon months (Jun–Sep) in our region carry a
// real rain chance, otherwise mostly clear. Never random, so demos and tests are
// reproducible — it only stands in until live data is available.
function offlineWeather(now: Date): Weather {
  const { month } = istYearMonth(now); // 0=Jan, in India
  const monsoon = month >= 5 && month <= 8; // Jun–Sep
  if (monsoon) {
    // Afternoon/evening showers are the regional pattern.
    const hour = istHour(now);
    const showerWindow = hour >= 15 && hour < 21;
    return {
      condition: showerWindow ? "rain" : "clouds",
      temperatureC: 27,
      rainChance: showerWindow ? 0.6 : 0.3,
      source: "offline",
    };
  }
  return { condition: "clear", temperatureC: 31, rainChance: 0.05, source: "offline" };
}

// Open-Meteo weathercode → our condition buckets.
// 0 clear · 1–48 cloud/fog · 51–67 drizzle/rain · 80–82 showers · 95+ thunder.
function mapWeatherCode(code: number): Weather["condition"] {
  if (code === 0) return "clear";
  if (code >= 95) return "heavy_rain"; // thunderstorm
  if (code === 65 || code === 82) return "heavy_rain"; // heavy rain / violent showers
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code >= 1 && code <= 48) return "clouds";
  return "clouds";
}

async function fetchWeather(
  lat: number,
  lng: number,
  now: Date,
): Promise<Weather> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,weather_code&hourly=precipitation_probability` +
      `&forecast_days=1&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(`weather ${r.status}`);
    const data = (await r.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
      hourly?: { precipitation_probability?: number[] };
    };
    const code = data.current?.weather_code;
    const temp = data.current?.temperature_2m ?? null;
    // Next-hour precip probability (first entry is the current hour).
    const probs = data.hourly?.precipitation_probability;
    const nextHourIdx = Math.min((probs?.length ?? 1) - 1, istHour(now) + 1);
    const rainChance =
      probs && probs.length > 0 ? (probs[nextHourIdx] ?? probs[0]!) / 100 : null;
    if (code == null) throw new Error("no weather_code");
    return {
      condition: mapWeatherCode(code),
      temperatureC: temp,
      rainChance,
      source: "live",
    };
  } catch {
    return offlineWeather(now);
  }
}

export type ContextOptions = {
  lat?: number | null;
  lng?: number | null;
  now?: Date;
  // Skip the network call (tests / when weather isn't needed).
  skipWeather?: boolean;
};

export async function buildContext(
  opts: ContextOptions = {},
): Promise<DecisionContext> {
  const now = opts.now ?? new Date();
  const hour = istHour(now);
  const lat = opts.lat ?? DEFAULT_LAT;
  const lng = opts.lng ?? DEFAULT_LNG;

  const weather = opts.skipWeather
    ? offlineWeather(now)
    : await fetchWeather(lat, lng, now);

  const wet =
    weather.condition === "rain" ||
    weather.condition === "heavy_rain" ||
    (weather.rainChance ?? 0) >= 0.5;

  return {
    now,
    hour,
    timeOfDay: timeOfDayFor(hour),
    isPeakCommute: isPeak(hour),
    isMealWindow: isMeal(hour),
    weather,
    // People hail rides when it's wet or at commute peaks → demand/surge rises.
    rideDemandLikely: wet || isPeak(hour),
  };
}
