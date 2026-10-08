// The Rules Engine layer: what is invalid, decided before anything is ranked.
//
// A hard constraint removes a candidate. It is never traded against quality,
// never waived because nothing survives, and never softened by a preference.
// "A ₹320 option must not survive a strict ₹300 maximum just because it has a
// high rating" is the founding requirement, and the reason this is a separate
// step rather than one more weight in the scorer: a weight can always be
// outvoted, and a constraint must not be.
//
// Deliberately domain-agnostic. Food and rides each describe their candidates
// through a `view`, so no provider or domain logic lives in here, and the same
// rules apply identically to both.
//
// Distinct from a soft ceiling such as the weekly Budget Guardian's remaining
// allowance. That is advice about spending and belongs in ranking; a price the
// customer stated belongs here. Passing one where the other is meant would
// either break a promise or refuse every search, so they are separate inputs.

export type HardConstraints = {
  /** A price the customer stated, such as "under ₹300". */
  maxPricePaise?: number | null;
  /**
   * The latest acceptable arrival, in minutes. Delivery time for food; for a
   * ride, the whole journey, pickup wait plus the trip itself.
   */
  maxEtaMinutes?: number | null;
  /** Rides only: the longest the customer will wait to be picked up. */
  maxPickupMinutes?: number | null;
};

/** How a candidate presents itself to the constraints. */
export type ConstraintView = {
  pricePaise: number;
  etaMinutes: number;
  /** Absent for anything without a pickup, which the pickup rule then skips. */
  pickupMinutes?: number;
};

export type HardRule = "max_price" | "max_pickup" | "max_eta";

export type Rejection = { rule: HardRule; count: number };

export type NearestMiss<T> = {
  item: T;
  rule: HardRule;
  /** How far over the limit, in that rule's own unit: paise or minutes. */
  by: number;
};

export type ConstraintResult<T> = {
  kept: T[];
  rejected: Rejection[];
  /**
   * The rejected candidate that came closest, present only when nothing
   * survived. It exists to let a caller say "nothing is under ₹300, the
   * nearest is ₹320" as information. It is never a recommendation, and a
   * caller that ranks it has broken the rule this module exists to enforce.
   */
  nearestMiss: NearestMiss<T> | null;
};

/**
 * The order a candidate failing several rules is attributed in.
 *
 * Each removed candidate is counted against exactly one rule, so the counts
 * sum to the number removed, which the decision log records as a single
 * total. Price comes first because it is the constraint customers state most
 * and the one a wrong explanation would most damage.
 */
const RULE_ORDER: HardRule[] = ["max_price", "max_pickup", "max_eta"];

/**
 * Only a positive, finite number is a constraint.
 *
 * Anything else means the customer did not set one. A zero reaching here would
 * otherwise remove every candidate and report that nothing is available, which
 * is a far worse failure than ignoring a limit nobody could have meant.
 */
function limit(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function firstViolation(
  v: ConstraintView,
  c: { price: number | null; pickup: number | null; eta: number | null },
): { rule: HardRule; by: number; ratio: number } | null {
  for (const rule of RULE_ORDER) {
    if (rule === "max_price" && c.price !== null && v.pricePaise > c.price) {
      const by = v.pricePaise - c.price;
      return { rule, by, ratio: by / c.price };
    }
    if (
      rule === "max_pickup" &&
      c.pickup !== null &&
      v.pickupMinutes !== undefined &&
      v.pickupMinutes > c.pickup
    ) {
      const by = v.pickupMinutes - c.pickup;
      return { rule, by, ratio: by / c.pickup };
    }
    if (rule === "max_eta" && c.eta !== null && v.etaMinutes > c.eta) {
      const by = v.etaMinutes - c.eta;
      return { rule, by, ratio: by / c.eta };
    }
  }
  return null;
}

export function applyHardConstraints<T>(
  items: T[],
  view: (item: T) => ConstraintView,
  constraints: HardConstraints | null | undefined,
): ConstraintResult<T> {
  const c = {
    price: limit(constraints?.maxPricePaise),
    pickup: limit(constraints?.maxPickupMinutes),
    eta: limit(constraints?.maxEtaMinutes),
  };

  if (c.price === null && c.pickup === null && c.eta === null) {
    return { kept: items.slice(), rejected: [], nearestMiss: null };
  }

  const kept: T[] = [];
  const counts = new Map<HardRule, number>();
  let closest: (NearestMiss<T> & { ratio: number }) | null = null;

  for (const item of items) {
    const violation = firstViolation(view(item), c);
    if (!violation) {
      kept.push(item);
      continue;
    }
    counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
    // Overshoot is compared as a fraction of its own limit, so ₹20 over ₹300
    // and two minutes over five are measured on one scale.
    if (!closest || violation.ratio < closest.ratio) {
      closest = { item, rule: violation.rule, by: violation.by, ratio: violation.ratio };
    }
  }

  const rejected = RULE_ORDER.filter((r) => counts.has(r)).map((rule) => ({
    rule,
    count: counts.get(rule)!,
  }));

  return {
    kept,
    rejected,
    nearestMiss:
      kept.length === 0 && closest
        ? { item: closest.item, rule: closest.rule, by: closest.by }
        : null,
  };
}
