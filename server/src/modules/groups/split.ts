// Dividing one fare between the people sharing it.
//
// Each share used to be round(fare / riders), the same for everyone. That
// does not add up: ₹100 between three is ₹33.33 each, ₹99.99 in total, and
// the host who paid the whole fare is a paisa short on every such trip, more
// with more riders. Every friend now owes the same whole-paisa share and the
// host absorbs the remainder, so the shares always sum to the fare exactly.
// The host is the one who paid, so they are the one who can carry a paisa.

/** Splits `totalPaise` across `people`, host first. Shares sum to the total. */
export function splitFare(
  totalPaise: number,
  people: number,
): { hostPaise: number; otherPaise: number } {
  const n = Math.max(1, Math.floor(people));
  const otherPaise = Math.floor(totalPaise / n);
  return { hostPaise: totalPaise - otherPaise * (n - 1), otherPaise };
}

/** "₹33" or "₹33.34": whole rupees when the share is whole, exact otherwise. */
export function rupeesExact(paise: number): string {
  return `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;
}
