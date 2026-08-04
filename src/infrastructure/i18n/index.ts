// See docs/specs/i18n.md. Catalogs are imported statically for now — with
// two locales and one namespace this is simpler and just as correct as
// dynamic per-locale chunks; revisit if/when the catalog list grows enough
// to matter for bundle size.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en/common.json";
import ru from "@/locales/ru/common.json";
import { DEFAULT_LOCALE } from "@/locales/registry";

export const i18n = i18next.use(initReactI18next);

let initialized = false;

export async function initI18n(initialLocale: string): Promise<void> {
  if (initialized) return;
  initialized = true;

  await i18n.init({
    resources: {
      en: { common: en },
      ru: { common: ru },
    },
    ns: ["common"],
    defaultNS: "common",
    lng: initialLocale,
    // Selected locale -> English -> raw key (docs/specs/i18n.md's fallback
    // chain) — a missing key is loud, never a blank label.
    fallbackLng: DEFAULT_LOCALE,
    interpolation: { escapeValue: false },
  });
}

export function setLocale(locale: string): Promise<unknown> {
  return i18n.changeLanguage(locale);
}
