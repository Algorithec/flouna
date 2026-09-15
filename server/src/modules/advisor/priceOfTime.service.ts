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
// It is computed from the most recent orders the customer placed in this
// product, a rolling window described at DECISION_WINDOW below. Nothing here
// observes anything they did not do.

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
  /**
   * Paise this person will spend to save a minute, or null when their choices
   * contradict each other on price and time and no single figure is honest.
   */
  paisePerMinute: number | null;
  /**
   * The band their own choices pin down. When `contradictory` is true these are
   * reported as observed, lower above upper, rather than forced into agreement.
   */
  lowerPaisePerMinute: number;
  /** Null when nothing they turned down puts a ceiling on it. */
  upperPaisePerMinute: number | null;
  /** Choices that constrained the answer at all. */
  informative: number;
  /**
   * Choices that price and time alone cannot explain, such as paying more for
   * a slower option. Named for exactly that: it is not a measure of how
   * consistent a person is in general, only of how far price and time account
   * for what they chose. Someone choosing on quality scores high here and is
   * behaving perfectly sensibly.
   */
  inconsistentOnPriceTime: number;
  /**
   * True when the floor their choices set is above the ceiling. Their decisions
   * cannot all be about time, so there is no figure to give.
   */
  contradictory: boolean;
  confident: boolean;
};

// Below this many informative choices, the estimate exists but must not steer
// anything.
//
// Six is a starting heuristic, not a statistically derived number, and should
// not be read as one. Two or three trade-offs are easily coincidence, and
// nothing yet exists to set it from: there has been no paired order data to
// measure how quickly a real customer's band settles. Once there is, it should
// be chosen from that data.
const CONFIDENT_AT = 6;
// A band wider than this is not a usable claim. Tightened from ₹15 a minute
// after review: a customer whose time is worth anywhere between ₹2 and ₹17 a
// minute has told us too little to rank on. Like the count above, a heuristic
// to be replaced by a value measured from real outcomes.
const MAX_CONFIDENT_SPREAD_PAISE = 500; // ₹5 a minute

/**
 * How many of a customer's most recent paired orders the estimate reads.
 *
 * A rolling window, so older choices age out: once there are 100 newer
 * orders, the 101st no longer counts. Deliberate, since what a minute is worth
 * to someone changes over time, and it bounds the cost of the read. Named here
 * so nobody later has to discover it by wondering why an old decision stopped
 * affecting the result.
 */
export const DECISION_WINDOW = 100;

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
  let inconsistentOnPriceTime = 0;
  let informative = 0;

  for (const d of decisions) {
    const c = constraintsFrom(d);
    if (c.lower.length || c.upper.length) informative++;
    inconsistentOnPriceTime += c.inconsistent;
    lowers.push(...c.lower);
    uppers.push(...c.upper);
  }

  if (lowers.length === 0 && uppers.length === 0) return null;

  // The tightest band every choice agrees with.
  const lower = lowers.length ? Math.max(...lowers) : 0;
  const upper = uppers.length ? Math.min(...uppers) : null;

  // Crossed bounds mean the choices cannot all be about time. This used to
  // take the midpoint, which review rightly called out: a floor of ₹10 and a
  // ceiling of ₹2 became ₹6 a minute, a figure nothing the customer did
  // supports. There is no honest single number, so none is given. The observed
  // bounds are kept as evidence, and the result is never confident, so nothing
  // ranks on it.
  if (upper !== null && lower > upper) {
    return {
      paisePerMinute: null,
      lowerPaisePerMinute: Math.round(lower),
      upperPaisePerMinute: Math.round(upper),
      informative,
      inconsistentOnPriceTime,
      contradictory: true,
      confident: false,
    };
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
    inconsistentOnPriceTime,
    contradictory: false,
    confident:
      informative >= CONFIDENT_AT &&
      inconsistentOnPriceTime < informative / 2 &&
      spread <= MAX_CONFIDENT_SPREAD_PAISE,
  };
}

/** Rupees per minute, for anywhere this is shown to a person. */
export function rupeesPerMinute(v: TimeValue): number | null {
  return v.paisePerMinute === null ? null : Math.round((v.paisePerMinute / 100) * 10) / 10;
}

/**
 * The same estimate, from what this user has actually chosen.
 *
 * Reads only decisions that were paired with an order, because an unpaired one
 * records a recommendation nobody acted on and says nothing about a trade-off.
 */
export async function timeValueForUser(
  userId: string,
  limit = DECISION_WINDOW,
): Promise<TimeValue | null> {
  const rows = await prisma.decisionLog.findMany({
    // On the order, not only the selection. Review pointed out these are not
    // the same claim: a selected option is not proof an order was placed, and
    // this reads only choices that became orders.
    where: { userId, selectedKey: { not: null }, orderId: { not: null } },
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
