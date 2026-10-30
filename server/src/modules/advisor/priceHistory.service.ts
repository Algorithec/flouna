import { prisma } from "../../lib/prisma.js";
import { istHour, istWeekday } from "../../lib/istTime.js";
import type { AdviceCode } from "./advisor.service.js";

// Records the cheapest price seen for a dish/vehicle at this moment. Called
// (fire-and-forget) whenever quotes are generated, so the dataset grows with use.
export function recordObservation(
  domain: "food" | "ride",
  key: string,
  bestPaise: number,
  now: Date = new Date(),
) {
  void prisma.priceObservation
    .create({
      data: {
        domain,
        key,
        bestPaise,
        hour: istHour(now),
        weekday: (istWeekday(now) + 6) % 7,
      },
    })
    .catch(() => {
      // Observations are best-effort; never block a user request on them.
    });
}

const MIN_SAMPLES_PER_HOUR = 3;
const MAX_LOOKAHEAD_HOURS = 4;

export type HistoryPrediction = {
  source: "history";
  action: "order_now" | "wait";
  message: string;
  code: AdviceCode;
  expectedSavingPaise?: number;
  waitMinutes?: number;
};

// Looks at observed averages by hour for this key. If a cheaper hour is coming
// up soon (and we have enough samples to trust it), suggests waiting.
// Returns null when there isn't enough data — caller falls back to rules.
export async function predictFromHistory(
  domain: "food" | "ride",
  key: string,
  now: Date = new Date(),
): Promise<HistoryPrediction | null> {
  const rows = await prisma.priceObservation.findMany({
    where: { domain, key },
    select: { hour: true, bestPaise: true },
  });
  if (rows.length < MIN_SAMPLES_PER_HOUR * 2) return null;

  // Average price + sample count per hour.
  const byHour = new Map<number, { sum: number; n: number }>();
  for (const r of rows) {
    const cur = byHour.get(r.hour) ?? { sum: 0, n: 0 };
    cur.sum += r.bestPaise;
    cur.n += 1;
    byHour.set(r.hour, cur);
  }

  const currentHour = istHour(now);
  const currentStats = byHour.get(currentHour);
  if (!currentStats || currentStats.n < MIN_SAMPLES_PER_HOUR) return null;
  const currentAvg = currentStats.sum / currentStats.n;

  // Scan the next few hours for a well-sampled, meaningfully cheaper slot.
  let best: { hour: number; avg: number; ahead: number } | null = null;
  for (let ahead = 1; ahead <= MAX_LOOKAHEAD_HOURS; ahead++) {
    const h = (currentHour + ahead) % 24;
    const stats = byHour.get(h);
    if (!stats || stats.n < MIN_SAMPLES_PER_HOUR) continue;
    const avg = stats.sum / stats.n;
    if (avg < currentAvg && (!best || avg < best.avg)) {
      best = { hour: h, avg, ahead };
    }
  }

  if (best) {
    const saving = Math.round(currentAvg - best.avg);
    // Ignore trivial differences (< ₹10) — not worth telling the user to wait.
    if (saving >= 1000) {
      const rupees = Math.round(saving / 100);
      // A ride is booked, not ordered.
      const ask = domain === "ride" ? "Book now, or wait and save?" : "Order now, or wait and save?";
      return {
        source: "history",
        action: "wait",
        message: `Based on recent pricing, this is usually about ₹${rupees} cheaper in ${best.ahead} hr${best.ahead > 1 ? "s" : ""}. ${ask}`,
        code: {
          code: domain === "ride" ? "historyWaitRide" : "historyWaitFood",
          params: { rupees: String(rupees), minutes: String(best.ahead * 60) },
        },
        expectedSavingPaise: saving,
        waitMinutes: best.ahead * 60,
      };
    }
  }

  return {
    source: "history",
    action: "order_now",
    message:
      "Based on recent pricing, now is around the best time, waiting isn't likely to get you a better deal.",
    code: { code: "historyNow" },
  };
}
