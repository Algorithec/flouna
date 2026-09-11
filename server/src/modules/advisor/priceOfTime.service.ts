import { prisma } from "../../lib/prisma.js";

// What a minute is worth to this person, read from what they actually did.
//
// The architecture guide asks for derived utility: whether someone is
// speed-sensitive or price-sensitive, held with a confidence score. Today that
// is approximated by three spend bands, so every "mid spend" customer is
// treated identically, and the band is inferred from how much they spend
// rather than from any trade-off they made.
//
// A choice between a costlier, faster option and a cheaper, slower one says
// something much more precise. Take somebody who picks ₹270 at 25 minutes over
// ₹220 at 40 minutes: they paid 50 rupees to save 15 minutes, so a minute is
// worth at least 3.33 rupees to them. Decline the same trade and a minute is
// worth at most that. Every decision narrows a range, and the range is a real
// number about one person rather than a bucket.
//
// It is computed from choices the customer made in this product, and resets
// with their history. Nothing here observes anything they did not do.

/** One option as it was shown, in the key space the decision log records. */
export type ShownOption = {
  key: string;
  pricePaise: number;
  etaMinutes: number;
};

export type PricedDecision = {
  results: ShownOption[];
  selectedKey: string;
};

export type TimeValue = {
  /** Paise this person will spend to save a minute. */
  paisePerMinute: number;
  /** The band their own choices actually pin down. */
  lowerPaisePerMinute: number;
  /** Null when nothing they turned down puts a ceiling on it. */
  upperPaisePerMinute: number | null;
  /** Choices that constrained the answer at all. */
  informative: number;
  /**
   * Choices that contradict the rest on price and time alone. Not an error:
   * somebody who pays more for a slower option is telling us something real,
   * just not about time. Counted rather than hidden, because a profile built
   * mostly from contradictions should not be trusted.
   */
  inconsistent: number;
  confident: boolean;
};

// Below this, the estimate exists but must not steer anything. Two or three
// trade-offs are a coincidence; this is roughly where a range stops moving
// every time a new order arrives.
const CONFIDENT_AT = 6;
// A range wider than this is barely a claim. Kept generous, because a real
// person's price of time genuinely is a range and not a point.
const MAX_CONFIDENT_SPREAD_PAISE = 1500; // ₹15 a minute

/**
 * Reads the trade-offs out of one decision.
 *
 * Every option that was shown and not taken is compared with the one that was,
 * and only pairs that differ in both price and time say anything. An option
 * beaten on both counts reveals nothing: nobody needs a theory of time to
 * explain refusing something slower AND dearer.
 */
function constraintsFrom(decision: PricedDecision): {
  lower: number[];
  upper: number[];
  inconsistent: number;
} {
  const chosen = decision.results.find((r) => r.key === decision.selectedKey);
  const lower: number[] = [];
  const upper: number[] = [];
  let inconsistent = 0;
  if (!chosen) return { lower, upper, inconsistent };

  for (const alt of decision.results) {
    if (alt.key === chosen.key) continue;
    const priceGap = chosen.pricePaise - alt.pricePaise;
    const timeGap = alt.etaMinutes - chosen.etaMinutes;
    if (priceGap === 0 || timeGap === 0) continue;

    if (priceGap > 0 && timeGap > 0) {
      // Paid more, arrived sooner: a minute is worth at least this much.
      lower.push(priceGap / timeGap);
    } else if (priceGap < 0 && timeGap < 0) {
      // Saved money, waited longer: a minute is worth at most this much.
      upper.push(-priceGap / -timeGap);
    } else if (priceGap > 0 && timeGap < 0) {
      // Dearer and slower. Something else decided it, most likely quality.
      inconsistent++;
    }
    // Cheaper and faster is the dominant option and constrains nothing.
  }
  return { lower, upper, inconsistent };
}

/**
 * Estimates the price of a minute from a person's decisions.
 *
 * Returns null when nothing they did narrows it, which is the honest answer
 * for a new account and is deliberately distinct from "we think it is zero".
 */
export function estimateTimeValue(decisions: PricedDecision[]): TimeValue | null {
  const lowers: number[] = [];
  const uppers: number[] = [];
  let inconsistent = 0;
  let informative = 0;

  for (const d of decisions) {
    const c = constraintsFrom(d);
    if (c.lower.length || c.upper.length) informative++;
    inconsistent += c.inconsistent;
    lowers.push(...c.lower);
    uppers.push(...c.upper);
  }

  if (lowers.length === 0 && uppers.length === 0) return null;

  // The tightest band every choice agrees with.
  let lower = lowers.length ? Math.max(...lowers) : 0;
  let upper = uppers.length ? Math.min(...uppers) : null;

  // Crossed bounds mean the choices cannot all be about time. Rather than
  // report an empty range, fall back to the middle of what was claimed: it is
  // the least wrong summary, and `inconsistent` says how much to trust it.
  if (upper !== null && lower > upper) {
    const mid = (lower + upper) / 2;
    inconsistent += 1;
    lower = mid;
    upper = mid;
  }

  // With no ceiling, the most they are known to pay is the best estimate we
  // have. Inventing a higher number would be inventing evidence.
  const paisePerMinute = upper === null ? lower : (lower + upper) / 2;
  const spread = upper === null ? Infinity : upper - lower;

  return {
    paisePerMinute: Math.round(paisePerMinute),
    lowerPaisePerMinute: Math.round(lower),
    upperPaisePerMinute: upper === null ? null : Math.round(upper),
    informative,
    inconsistent,
    confident:
      informative >= CONFIDENT_AT &&
      inconsistent < informative / 2 &&
      spread <= MAX_CONFIDENT_SPREAD_PAISE,
  };
}

/** Rupees per minute, for anywhere this is shown to a person. */
export function rupeesPerMinute(v: TimeValue): number {
  return Math.round((v.paisePerMinute / 100) * 10) / 10;
}

/**
 * The same estimate, from what this user has actually chosen.
 *
 * Reads only decisions that were paired with an order, because an unpaired one
 * records a recommendation nobody acted on and says nothing about a trade-off.
 */
export async function timeValueForUser(
  userId: string,
  limit = 100,
): Promise<TimeValue | null> {
  const rows = await prisma.decisionLog.findMany({
    where: { userId, selectedKey: { not: null } },
    orderBy: { selectedAt: "desc" },
    take: limit,
    select: { results: true, selectedKey: true },
  });

  const decisions: PricedDecision[] = [];
  for (const row of rows) {
    if (!row.selectedKey) continue;
    try {
      const results = JSON.parse(row.results) as ShownOption[];
      if (Array.isArray(results) && results.length > 1) {
        decisions.push({ results, selectedKey: row.selectedKey });
      }
    } catch {
      // A row we cannot read is a row we skip. One bad record must not take
      // the whole profile down with it.
    }
  }
  return estimateTimeValue(decisions);
}
