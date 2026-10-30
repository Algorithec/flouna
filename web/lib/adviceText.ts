import type { TranslationKey } from "@/lib/i18n/dictionaries";

type T = (key: TranslationKey) => string;
type Coded = { code: string; params?: Record<string, string> } | null | undefined;

/** A wait in the reader's units: "45 min", "1 hr 30 min", "2 hrs". */
function duration(t: T, minutes: number): string {
  if (minutes < 60) return `${minutes} ${t("u.min")}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = `${h} ${h === 1 ? t("u.hr") : t("u.hrs")}`;
  return m === 0 ? hours : `${hours} ${m} ${t("u.min")}`;
}

/**
 * A sentence from the timing advisor in the reader's language. The server
 * sends a code with each sentence it knows (`adv.m.<code>`); a minutes figure
 * becomes {wait} in the reader's units. Anything else is shown as it came.
 */
export function adviceText(t: T, english: string, coded: Coded): string {
  if (!coded) return english;
  const key = `adv.m.${coded.code}` as TranslationKey;
  const said = t(key);
  if (said === key) return english;
  const params: Record<string, string> = { ...coded.params };
  if (params.minutes) params.wait = duration(t, Number(params.minutes));
  return Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), said);
}
