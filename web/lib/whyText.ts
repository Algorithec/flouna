import type { TranslationKey } from "@/lib/i18n/dictionaries";

type Part = { code: string; params?: Record<string, string> };

/**
 * The reason for a pick in the reader's language, joined from the fragments
 * the server sends (`why.f.<code>`, each carrying its own punctuation). If any
 * fragment is one the app has no translation for, the English is shown whole
 * rather than a sentence that is half one language and half another.
 */
export function whyText(t: (key: TranslationKey) => string, english: string, parts: Part[] | null | undefined): string {
  if (!parts?.length) return english;
  const out: string[] = [];
  for (const part of parts) {
    const key = `why.f.${part.code}` as TranslationKey;
    const said = t(key);
    if (said === key) return english;
    out.push(Object.entries(part.params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), said));
  }
  return out.join("");
}
