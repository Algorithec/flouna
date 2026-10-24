// Problems a customer is shown on an ONDC order or ride.
//
// Each is still stored as English in `problem`: operators read it there, and
// a problem not listed here (a seller's own error text, say) is shown as it
// is. The app is also handed a code for each one listed, which it translates,
// so a customer reading Telugu does not get these in English.

export const PROBLEM = {
  sellerUnreachable: "The seller's app did not accept the request. Try again in a moment.",
  paidNotPlaced: "Paid, but the store could not be reached yet. Place the order again.",
  sellerRefused: "The seller did not accept the order",
  cancelRefused: "The seller did not agree to cancel this order",
  cannotDeliver: "The store cannot deliver to this address",
  splitDelivery: "The store would deliver this order in parts, which is not supported yet",
  someOutOfStock: "Some items are out of stock",
  notServed: "This location is not served by the store",
  notTaking: "The store is not taking orders right now",
  itemGone: "An item is not available any more",
  storeClosed: "The store has closed for now",
  refundNoBill: "The seller cancelled without a final bill, so the refund needs checking",
  refundOverBill: "The seller's final bill is more than was paid",
  providerUnreachable: "The ride provider's app did not accept the request. Try again in a moment.",
  searchRefused: "The ONDC network did not accept the search just now",
  bookingFailed: "The provider could not book this ride",
  rideCancelRefused: "The provider did not cancel this ride",
} as const;

export const fareChangedProblem = (fromPaise: number, toPaise: number) => `Fare updated from ₹${fromPaise / 100} to ₹${toPaise / 100}`;
export const billReducedProblem = (fromPaise: number, toPaise: number) =>
  `The seller reduced the bill from ${fromPaise / 100} to ${toPaise / 100} rupees; refund the difference`;
export const outOfStockProblem = (items: string[]) => `Out of stock: ${items.join(", ")}`;

/** How each template above is read back into its code and the values in it. */
const TEMPLATES: { code: string; re: RegExp; names: string[] }[] = [
  { code: "fareChanged", re: /^Fare updated from ₹([\d.]+) to ₹([\d.]+)$/, names: ["from", "to"] },
  { code: "billReduced", re: /^The seller reduced the bill from ([\d.]+) to ([\d.]+) rupees/, names: ["from", "to"] },
  { code: "outOfStock", re: /^Out of stock: (.+)$/, names: ["items"] },
];
const BY_TEXT = new Map<string, string>(Object.entries(PROBLEM).map(([code, text]) => [text, code]));

export type ProblemCode = { code: string; params?: Record<string, string> };

/** The code the app translates a problem by, or null for one it shows as it is. */
export function problemCode(problem: string | null | undefined): ProblemCode | null {
  if (!problem) return null;
  const code = BY_TEXT.get(problem);
  if (code) return { code };
  for (const t of TEMPLATES) {
    const m = t.re.exec(problem);
    if (m) return { code: t.code, params: Object.fromEntries(t.names.map((n, i) => [n, m[i + 1] ?? ""])) };
  }
  return null;
}
