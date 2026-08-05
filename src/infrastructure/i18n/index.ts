// See docs/specs/i18n.md. Catalogs are imported statically for now — with
// a small locale set and a handful of namespaces this is simpler and just as
// correct as dynamic per-locale chunks; revisit if/when the catalog list grows.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import deCommon from "@/locales/de/common.json";
import deWorkspace from "@/locales/de/workspace.json";
import enCommon from "@/locales/en/common.json";
import ruCommon from "@/locales/ru/common.json";
import esCommon from "@/locales/es/common.json";
import esWorkspace from "@/locales/es/workspace.json";
import frCommon from "@/locales/fr/common.json";
import frWorkspace from "@/locales/fr/workspace.json";
import enWorkspace from "@/locales/en/workspace.json";
import ruWorkspace from "@/locales/ru/workspace.json";
import { DEFAULT_LOCALE } from "@/locales/registry";

export const i18n = i18next.use(initReactI18next);

let initialized = false;

export async function initI18n(initialLocale: string): Promise<void> {
  if (initialized) return;
  initialized = true;

  await i18n.init({
    resources: {
      en: { common: enCommon, workspace: enWorkspace },
      ru: { common: ruCommon, workspace: ruWorkspace },
      es: { common: esCommon, workspace: esWorkspace },
      de: { common: deCommon, workspace: deWorkspace },
      fr: { common: frCommon, workspace: frWorkspace },
    },
    ns: ["common", "workspace"],
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
