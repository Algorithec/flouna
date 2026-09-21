/**
 * Format large numbers to a readable string with K for thousands.
 * e.g., 2300 -> "2.3K", 950 -> "950"
 */
export function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}
