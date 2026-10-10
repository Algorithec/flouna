/**
 * Clock arithmetic in the only timezone this product serves.
 *
 * Every time-of-day decision here was reading the server process's clock
 * through getHours() and getDay(). On a developer's machine in India that is
 * IST and everything looks right; on a VPS, which runs UTC by default, the
 * same code is five and a half hours out. Nothing throws, so it would have
 * shipped and quietly gone wrong: the timing advisor calling 8pm dinner-time
 * "mid-afternoon", price history filed under the wrong hour and, either side
 * of midnight, the wrong weekday, and a Monday-morning order counted against
 * last week's food budget.
 *
 * Setting TZ on the host would also work, but it fixes this in a place no
 * reader of this code can see, and one wrong deployment silently reintroduces
 * the whole class. Doing the arithmetic here cannot be undone by a config
 * file.
 *
 * A fixed offset is correct rather than a shortcut: India keeps one timezone
 * and has observed no daylight saving since 1945.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** The wall-clock fields a person in India would read off their phone. */
export function istParts(at: Date = new Date()): {
  hour: number;
  minute: number;
  /** 0 = Sunday, matching Date#getDay. */
  weekday: number;
} {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Hour of the day in India, 0–23. */
export function istHour(at: Date = new Date()): number {
  return istParts(at).hour;
}

/** Day of the week in India, 0 = Sunday. */
export function istWeekday(at: Date = new Date()): number {
  return istParts(at).weekday;
}

/** Midnight in India, as the real instant that moment happened. */
export function istStartOfDay(at: Date = new Date()): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

/**
 * Monday 00:00 in India, as a real instant.
 *
 * The week the budget is measured over. A rider ordering at 1am on Monday is
 * spending this week's money, which is only true if the boundary is drawn in
 * their timezone rather than the server's.
 */
export function istStartOfWeek(at: Date = new Date()): Date {
  const day = (istWeekday(at) + 6) % 7; // Monday = 0
  return new Date(istStartOfDay(at).getTime() - day * 24 * 60 * 60_000);
}

/**
 * A time as a customer in India reads it, e.g. "10:00 pm".
 *
 * "en-IN" only decides how a time is written, not which zone it is in. On
 * Railway's UTC servers, toLocaleTimeString("en-IN") turned a ride booked for
 * 10 pm into "scheduled for 4:30 pm". The zone has to be stated.
 */
export function istTimeLabel(at: Date): string {
  return at.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A date as a customer in India reads it; near midnight UTC it is often the next day there. */
export function istDateLabel(
  at: Date,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string {
  return at.toLocaleDateString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });
}

/**
 * YYYY-MM-DD in India, for anything keyed or bucketed by calendar day.
 *
 * The obvious `toISOString().slice(0, 10)` is the UTC day, which on a UTC host
 * puts the first five and a half hours of every Indian day under the day
 * before.
 */
export function istDayKey(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Year and month (0 = January) in India, for anything keyed by calendar month. */
export function istYearMonth(at: Date = new Date()): { year: number; month: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
}
