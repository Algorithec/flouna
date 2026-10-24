"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  dictionaries,
  LANGUAGES,
  type Lang,
  type TranslationKey,
} from "@/lib/i18n/dictionaries";
import { LANG_STORAGE_KEY as STORAGE_KEY } from "@/lib/i18n/lang";

type I18nState = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TranslationKey) => string;
  speechLang: string;
};

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  // Restore the saved language after mount (avoids SSR/CSR mismatch).
  // Deferred a tick so the state update happens in a callback, not the
  // effect body (localStorage is an external store).
  useEffect(() => {
    const tmr = setTimeout(() => {
      const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
      if (saved && saved in dictionaries) {
        setLangState(saved);
        document.documentElement.lang = saved;
      }
    }, 0);
    return () => clearTimeout(tmr);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem(STORAGE_KEY, l);
    document.documentElement.lang = l;
  }, []);

  const t = useCallback(
    (key: TranslationKey) => dictionaries[lang][key] ?? dictionaries.en[key] ?? key,
    [lang],
  );

  const speechLang =
    LANGUAGES.find((l) => l.code === lang)?.speechLang ?? "en-IN";

  return (
    <I18nContext.Provider value={{ lang, setLang, t, speechLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
