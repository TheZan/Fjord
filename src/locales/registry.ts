// Single source of truth for supported locales — see docs/specs/i18n.md
// ("adding a locale" is a content-only change: new catalog files here, plus
// one entry in this array. No component should hardcode a locale code.)

export interface LocaleDescriptor {
  code: string;
  label: string;
}

export const SUPPORTED_LOCALES: LocaleDescriptor[] = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
];

export const DEFAULT_LOCALE = "en";
