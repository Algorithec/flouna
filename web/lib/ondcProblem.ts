import type { TranslationKey } from "@/lib/i18n/dictionaries";

type Coded = { code: string; params?: Record<string, string> } | null | undefined;

/**
 * A problem on an ONDC order or ride in the reader's language. The server
 * sends a code with each problem it knows; anything else is shown as it came.
 */
export function problemText(t: (key: TranslationKey) => string, problem: string | null, coded: Coded): string | null {
  if (!problem) return null;
  if (!coded) return problem;
  const key = `ondc.p.${coded.code}` as TranslationKey;
  const said = t(key);
  if (said === key) return problem;
  return Object.entries(coded.params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), said);
}
