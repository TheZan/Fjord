import type { Theme } from "@/domain/settings";
import type { StartupPreferences } from "@/application/StartupProvider";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/locales/registry";

const STORAGE_KEY = "fjord:startup-preferences:v1";

function systemLocale(): string {
  const language = navigator.language.toLowerCase();
  return (
    SUPPORTED_LOCALES.find(({ code }) => language === code || language.startsWith(`${code}-`))
      ?.code ?? DEFAULT_LOCALE
  );
}

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function readStartupPreferences(): StartupPreferences {
  const fallback: StartupPreferences = {
    locale: systemLocale(),
    theme: "system",
    performanceDiagnostics: false,
  };

  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<StartupPreferences> | null;
    if (!parsed) return fallback;
    return {
      locale: SUPPORTED_LOCALES.some(({ code }) => code === parsed.locale)
        ? parsed.locale!
        : fallback.locale,
      theme: isTheme(parsed.theme) ? parsed.theme : fallback.theme,
      performanceDiagnostics:
        typeof parsed.performanceDiagnostics === "boolean"
          ? parsed.performanceDiagnostics
          : fallback.performanceDiagnostics,
    };
  } catch {
    return fallback;
  }
}

export function writeStartupPreferences(preferences: StartupPreferences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Startup remains functional when WebView storage is unavailable.
  }
}
