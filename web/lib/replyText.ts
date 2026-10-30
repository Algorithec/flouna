import type { TranslationKey } from "@/lib/i18n/dictionaries";

type Coded = { code: string; params?: Record<string, string> } | null | undefined;

/**
 * The chat's reply in the reader's language. The server sends a code with each
 * sentence of its own (`chat.r.<code>`); a hosted model's words, and anything
 * the app has no translation for, are shown as they came.
 */
export function replyText(t: (key: TranslationKey) => string, english: string, coded: Coded): string {
  if (!coded) return english;
  const key = `chat.r.${coded.code}` as TranslationKey;
  const said = t(key);
  if (said === key) return english;
  return Object.entries(coded.params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), said);
}
