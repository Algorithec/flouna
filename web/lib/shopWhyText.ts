import type { TranslationKey } from "@/lib/i18n/dictionaries";

type Part = { code: string; params?: Record<string, string> };

/**
 * The reason for a product pick in the reader's language, joined from the
 * fragments the server sends (`why.s.<code>`, each carrying its own
 * punctuation). If any fragment has no translation, the English is shown
 * whole rather than a sentence that is half one language and half another.
 */
export function shopWhyText(t: (key: TranslationKey) => string, english: string, parts: Part[] | null | undefined): string {
  if (!parts?.length) return english;
  const out: string[] = [];
  for (const part of parts) {
    const key = `why.s.${part.code}` as TranslationKey;
    const said = t(key);
    if (said === key) return english;
    out.push(Object.entries(part.params ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), said));
  }
  return out.join("");
}
