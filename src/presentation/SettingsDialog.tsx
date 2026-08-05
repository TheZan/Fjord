import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { setLocale } from "@/infrastructure/i18n";
import { useTheme } from "@/infrastructure/theme/ThemeProvider";
import { getSettings, updateSettings } from "@/infrastructure/tauriClient";
import { SUPPORTED_LOCALES } from "@/locales/registry";
import { Button, GroupLabel, Input, Muted } from "@/presentation/ui";
import type { Settings, Theme } from "@/domain/settings";

const THEME_CHOICES: Theme[] = ["light", "dark", "system"];
const CUSTOM_IDE_PREFIX = "custom:";

type SettingsSection = "general" | "appearance" | "tools";

const SECTION_CHOICES: SettingsSection[] = ["general", "appearance", "tools"];
const DEFAULT_SETTINGS: Settings = { locale: "en", theme: "system", defaultIde: null };

const IDE_CHOICES: Array<{ value: string | null; key: string }> = [
  { value: null, key: "auto" },
  { value: "code", key: "vscode" },
  { value: "code-insiders", key: "vscodeInsiders" },
  { value: "cursor", key: "cursor" },
  { value: "windsurf", key: "windsurf" },
  { value: "zed", key: "zed" },
  { value: "idea", key: "idea" },
  { value: "webstorm", key: "webstorm" },
  { value: "pycharm", key: "pycharm" },
  { value: "clion", key: "clion" },
  { value: "rider", key: "rider" },
  { value: "rustrover", key: "rustrover" },
];

/**
 * Settings are set-once preferences, so they live behind a focused menu while
 * the sidebar keeps its space for workspaces and navigation.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { t: tw } = useTranslation("workspace");
  const { choice, setChoice } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customIde, setCustomIde] = useState("");

  useEffect(() => {
    let mounted = true;
    getSettings()
      .then((loaded) => {
        if (!mounted) return;
        setSettings(loaded);
        setCustomIde(customIdeCommand(loaded.defaultIde));
      })
      .catch((reason) => {
        if (!mounted) return;
        setError(errorMessage(reason));
      });

    return () => {
      mounted = false;
    };
  }, []);

  const currentSettings = useMemo<Settings>(
    () => settings ?? { ...DEFAULT_SETTINGS, locale: i18n.language, theme: choice },
    [choice, i18n.language, settings],
  );

  async function saveSettings(patch: Partial<Settings>, key: string) {
    const previous = currentSettings;
    const next = { ...previous, ...patch };
    setSettings(next);
    setPendingKey(key);
    setError(null);
    try {
      const persisted = await updateSettings(next);
      setSettings(persisted);
    } catch (reason) {
      setSettings(previous);
      setError(errorMessage(reason));
    } finally {
      setPendingKey(null);
    }
  }

  function chooseTheme(next: Theme) {
    setChoice(next);
    setSettings((current) => (current ? { ...current, theme: next } : current));
  }

  async function chooseLocale(locale: string) {
    await setLocale(locale);
    await saveSettings({ locale }, "locale");
  }

  function chooseDefaultIde(defaultIde: string | null) {
    void saveSettings({ defaultIde }, "defaultIde");
  }

  function commitCustomIde() {
    const trimmed = customIde.trim();
    void saveSettings({ defaultIde: trimmed ? `${CUSTOM_IDE_PREFIX}${trimmed}` : null }, "customIde");
  }

  const selectedIde = currentSettings.defaultIde?.startsWith(CUSTOM_IDE_PREFIX)
    ? "custom"
    : currentSettings.defaultIde;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      style={{ background: "rgba(8, 12, 16, 0.45)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[78vh] w-[760px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border shadow-2xl"
        style={{
          borderWidth: "0.5px",
          borderColor: "var(--hairline-strong)",
          background: "var(--paper)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <aside
          className="w-44 shrink-0 border-r p-3"
          style={{ borderRightWidth: "0.5px", borderColor: "var(--hairline)" }}
        >
          <h2 className="px-2 pb-3 text-[15px] font-medium">{tw("settings.title")}</h2>
          <nav className="flex flex-col gap-1">
            {SECTION_CHOICES.map((section) => (
              <button
                key={section}
                type="button"
                data-selected={activeSection === section}
                onClick={() => setActiveSection(section)}
                className="interactive-row rounded-md px-2 py-1.5 text-left text-[13px]"
                style={{
                  color: activeSection === section ? "var(--fjord-ink)" : "var(--slate)",
                  fontWeight: activeSection === section ? 500 : 400,
                }}
              >
                {t(`settings.sections.${section}`)}
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div
            className="flex items-center justify-between border-b px-5 py-3"
            style={{ borderBottomWidth: "0.5px", borderColor: "var(--hairline)" }}
          >
            <div>
              <h3 className="text-[14px] font-medium">{t(`settings.sections.${activeSection}`)}</h3>
              {error && <p className="mt-1 text-xs" style={{ color: "var(--rust-ink)" }}>{error}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="interactive-control flex h-8 w-8 items-center justify-center rounded-md"
              style={{ color: "var(--slate)" }}
              aria-label={tw("settings.close")}
              title={tw("settings.close")}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {activeSection === "general" && (
              <SettingsGroup title={t("settings.locale.label")}>
                <div className="grid grid-cols-2 gap-1.5">
                  {SUPPORTED_LOCALES.map((locale) => (
                    <Button
                      key={locale.code}
                      size="sm"
                      variant={currentSettings.locale === locale.code ? "primary" : "secondary"}
                      disabled={pendingKey === "locale"}
                      onClick={() => void chooseLocale(locale.code)}
                    >
                      {locale.label}
                    </Button>
                  ))}
                </div>
              </SettingsGroup>
            )}

            {activeSection === "appearance" && (
              <SettingsGroup title={t("settings.theme.label")}>
                <div className="grid grid-cols-3 gap-1.5">
                  {THEME_CHOICES.map((themeChoice) => (
                    <Button
                      key={themeChoice}
                      size="sm"
                      variant={choice === themeChoice ? "primary" : "secondary"}
                      onClick={() => chooseTheme(themeChoice)}
                    >
                      {t(`settings.theme.${themeChoice}`)}
                    </Button>
                  ))}
                </div>
              </SettingsGroup>
            )}

            {activeSection === "tools" && (
              <div className="flex flex-col gap-5">
                <SettingsGroup title={t("settings.defaultIde.label")}>
                  <div className="grid grid-cols-3 gap-1.5">
                    {IDE_CHOICES.map((ide) => (
                      <Button
                        key={ide.key}
                        size="sm"
                        variant={selectedIde === ide.value ? "primary" : "secondary"}
                        disabled={pendingKey === "defaultIde"}
                        onClick={() => chooseDefaultIde(ide.value)}
                      >
                        {t(`settings.defaultIde.${ide.key}`)}
                      </Button>
                    ))}
                  </div>
                </SettingsGroup>

                <SettingsGroup title={t("settings.defaultIde.custom")}>
                  <div className="flex gap-2">
                    <Input
                      value={customIde}
                      onChange={(event) => setCustomIde(event.target.value)}
                      onBlur={commitCustomIde}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      placeholder={t("settings.defaultIde.customPlaceholder")}
                      className="min-w-0 flex-1"
                    />
                    <Button
                      size="sm"
                      variant={selectedIde === "custom" ? "primary" : "secondary"}
                      disabled={pendingKey === "customIde"}
                      onClick={commitCustomIde}
                    >
                      {t("settings.defaultIde.saveCustom")}
                    </Button>
                  </div>
                  <Muted className="text-[11px]">{t("settings.defaultIde.customValue")}</Muted>
                </SettingsGroup>
              </div>
            )}
          </div>

          <div
            className="flex justify-end border-t px-5 py-3"
            style={{ borderTopWidth: "0.5px", borderColor: "var(--hairline)" }}
          >
            <Button onClick={onClose}>{tw("settings.close")}</Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <GroupLabel>{title}</GroupLabel>
      {children}
    </div>
  );
}

function customIdeCommand(defaultIde: string | null) {
  return defaultIde?.startsWith(CUSTOM_IDE_PREFIX)
    ? defaultIde.slice(CUSTOM_IDE_PREFIX.length).trim()
    : "";
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
      <path
        d="M4.25 4.25l7.5 7.5m0-7.5l-7.5 7.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}
