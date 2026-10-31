// CSV for the console's exports, opened by staff in Excel or Sheets.

/**
 * One cell. Text starting with = + - @ (or a tab or CR remnant) runs as a
 * formula in a spreadsheet, and names and titles here come from customers and
 * sellers, so such text is prefixed with ' to show as written. Numbers are
 * left as numbers: a variance of -12.50 must stay a figure that sums.
 */
export function csvCell(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

/** Paise as rupees with two decimals, for a column a spreadsheet can sum. */
export function rupeesCell(paise: number): number {
  return Math.round(paise) / 100;
}
