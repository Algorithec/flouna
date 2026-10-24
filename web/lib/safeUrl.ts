/**
 * A link a seller or ride provider sent, if it is plain https; otherwise
 * null. The server already keeps only https links; this keeps a javascript:
 * or data: one from ever becoming a clickable href should that change.
 */
export function safeHttps(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
