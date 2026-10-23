/**
 * Format large numbers to a readable string with K for thousands.
 * e.g., 2300 -> "2.3K", 950 -> "950"
 */
export function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/**
 * The reference a customer sees for an order: the end of its id, which is the
 * random part. Screens used to differ, the full id on one and its first eight
 * characters on another, and the start of an id is a timestamp, so orders
 * placed moments apart began the same.
 */
export function orderRef(id: string): string {
  return id.slice(-8).toUpperCase();
}
