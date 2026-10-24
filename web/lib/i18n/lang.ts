import { LANGUAGES, type Lang } from "./dictionaries";

/** Where the chosen language is kept between visits. */
export const LANG_STORAGE_KEY = "flouna.lang";

/**
 * The language saved on this device, for code that runs outside React and so
 * cannot use the i18n hook. English when nothing usable is saved, or when
 * storage cannot be read at all (a private window can throw on access).
 */
export function savedLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    const match = LANGUAGES.find((l) => l.code === saved);
    if (match) return match.code;
  } catch {
    // Fall through to English.
  }
  return "en";
}
