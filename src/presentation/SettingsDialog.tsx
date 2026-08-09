import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import { pickFile } from "@/infrastructure/dialog";
import { setLocale } from "@/infrastructure/i18n";
import { useTheme } from "@/infrastructure/theme/ThemeProvider";
import {
  getGitEnvironment,
  getSettings,
  resetGitExecutable,
  selectGitExecutable,
  testGitConnection,
  updateSettings,
} from "@/infrastructure/tauriClient";
import { SUPPORTED_LOCALES } from "@/locales/registry";
import { ConfirmActionDialog } from "@/presentation/GitContextMenu";
import { Button, GroupLabel, Input, Muted, Select } from "@/presentation/ui";
import type {
  GitConnectionTestResult,
  GitEnvironmentInfo,
  Settings,
  Theme,
} from "@/domain/settings";
import type { RepositoryEntry } from "@/domain/workspace";

const THEME_CHOICES: Theme[] = ["light", "dark", "system"];
const CUSTOM_IDE_PREFIX = "custom:";

type SettingsSection = "general" | "sync" | "git" | "appearance" | "tools";

const SECTION_CHOICES: SettingsSection[] = ["general", "sync", "git", "appearance", "tools"];
const DEFAULT_SETTINGS: Settings = {
  locale: "en",
  theme: "system",
  defaultIde: null,
  autoFetch: false,
  gitExecutablePath: null,
};

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
export function SettingsDialog({
  repositories,
  onClose,
  onSettingsChange,
}: {
  repositories: RepositoryEntry[];
  onClose: () => void;
  onSettingsChange?: (settings: Settings) => void;
}) {
  const { t, i18n } = useTranslation();
  const { t: tw } = useTranslation("workspace");
  const { choice, setChoice } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customIde, setCustomIde] = useState("");
  const [confirmAutoFetch, setConfirmAutoFetch] = useState(false);
  const [gitEnvironment, setGitEnvironment] = useState<GitEnvironmentInfo | null>(null);
  const [gitPending, setGitPending] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitDiagnostics, setGitDiagnostics] = useState<string | null>(null);
  const [connectionResult, setConnectionResult] = useState<GitConnectionTestResult | null>(null);
  const [connectionRepoId, setConnectionRepoId] = useState(repositories[0]?.id ?? "");

  // Inspection succeeds and reports the state rather than failing, so the panel
  // can say "the path you chose does not work" instead of showing a generic
  // error with no path in it (docs/tasks.md P5-20).
  const configuredPathInvalid = gitEnvironment?.configuredPathValid === false;

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
        setError(userErrorMessage(reason));
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    void refreshGitEnvironment();
  }, []);

  useEffect(() => {
    if (!connectionRepoId && repositories[0]) setConnectionRepoId(repositories[0].id);
  }, [connectionRepoId, repositories]);

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
      onSettingsChange?.(persisted);
    } catch (reason) {
      setSettings(previous);
      setError(userErrorMessage(reason));
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

  async function refreshGitEnvironment() {
    setGitPending(true);
    setGitError(null);
    setGitDiagnostics(null);
    try {
      setGitEnvironment(await getGitEnvironment());
    } catch (reason) {
      setGitEnvironment(null);
      setGitError(userErrorMessage(reason));
      setGitDiagnostics(readDiagnostics(reason));
    } finally {
      setGitPending(false);
    }
  }

  async function chooseGitExecutable() {
    const path = await pickFile();
    if (!path) return;
    setGitPending(true);
    setGitError(null);
    setGitDiagnostics(null);
    try {
      const environment = await selectGitExecutable(path);
      setGitEnvironment(environment);
      setSettings((current) => (current ? { ...current, gitExecutablePath: path } : current));
    } catch (reason) {
      setGitError(userErrorMessage(reason));
      setGitDiagnostics(readDiagnostics(reason));
    } finally {
      setGitPending(false);
    }
  }

  async function resetGitPath() {
    setGitPending(true);
    setGitError(null);
    setGitDiagnostics(null);
    try {
      setGitEnvironment(await resetGitExecutable());
      setSettings((current) => (current ? { ...current, gitExecutablePath: null } : current));
    } catch (reason) {
      setGitError(userErrorMessage(reason));
      setGitDiagnostics(readDiagnostics(reason));
    } finally {
      setGitPending(false);
    }
  }

  async function runConnectionTest() {
    if (!connectionRepoId) return;
    setGitPending(true);
    setGitError(null);
    setGitDiagnostics(null);
    setConnectionResult(null);
    try {
      setConnectionResult(await testGitConnection(connectionRepoId));
    } catch (reason) {
      setGitError(userErrorMessage(reason));
      setGitDiagnostics(readDiagnostics(reason));
    } finally {
      setGitPending(false);
    }
  }

  const selectedIde = currentSettings.defaultIde?.startsWith(CUSTOM_IDE_PREFIX)
    ? "custom"
    : currentSettings.defaultIde;
  const selectedLocale = SUPPORTED_LOCALES.some((locale) => locale.code === currentSettings.locale)
    ? currentSettings.locale
    : DEFAULT_SETTINGS.locale;

  return (
    <>
      <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      style={{ background: "rgba(8, 12, 16, 0.45)" }}
      onClick={onClose}
    >
      <div
        className="desktop-popover flex max-h-[78vh] w-[760px] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg border"
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
                <Select
                  value={selectedLocale}
                  disabled={pendingKey === "locale"}
                  onChange={(event) => void chooseLocale(event.target.value)}
                  className="w-64 max-w-full"
                >
                  {SUPPORTED_LOCALES.map((locale) => (
                    <option key={locale.code} value={locale.code}>
                      {locale.label}
                    </option>
                  ))}
                </Select>
              </SettingsGroup>
            )}

            {activeSection === "sync" && (
              <SettingsGroup title={t("settings.autoFetch.label")}>
                <div
                  className="flex items-center justify-between gap-5 rounded-md border px-3 py-3"
                  style={{ borderWidth: "0.5px", borderColor: "var(--hairline)" }}
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>
                      {t("settings.autoFetch.title")}
                    </div>
                    <Muted className="mt-0.5 block max-w-md text-[11px] leading-4">
                      {t("settings.autoFetch.description")}
                    </Muted>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={currentSettings.autoFetch}
                    aria-label={t("settings.autoFetch.title")}
                    disabled={pendingKey === "autoFetch"}
                    className="interactive-control relative h-5 w-9 shrink-0 rounded-full disabled:opacity-45"
                    style={{
                      background: currentSettings.autoFetch ? "var(--fjord)" : "var(--hairline-strong)",
                    }}
                    onClick={() => {
                      if (currentSettings.autoFetch) void saveSettings({ autoFetch: false }, "autoFetch");
                      else setConfirmAutoFetch(true);
                    }}
                  >
                    <span
                      className="absolute top-0.5 h-4 w-4 rounded-full transition-transform"
                      style={{
                        left: "2px",
                        background: "var(--paper)",
                        transform: currentSettings.autoFetch ? "translateX(16px)" : "translateX(0)",
                      }}
                    />
                  </button>
                </div>
              </SettingsGroup>
            )}

            {activeSection === "git" && (
              <div className="flex flex-col gap-5">
                <SettingsGroup title={t("settings.git.executable")}>
                  <div
                    className="rounded-md border p-3"
                    style={{
                      borderWidth: "0.5px",
                      borderColor: configuredPathInvalid ? "var(--rust)" : "var(--hairline)",
                      background: configuredPathInvalid ? "var(--rust-tint)" : undefined,
                    }}
                  >
                    <div
                      className="text-[13px] font-medium"
                      style={{ color: configuredPathInvalid ? "var(--rust-ink)" : "var(--ink)" }}
                    >
                      {configuredPathInvalid
                        ? t("settings.git.invalidPath")
                        : gitEnvironment
                          ? t("settings.git.found")
                          : t("settings.git.notFound")}
                    </div>
                    <Muted className="mt-1 block break-all text-[11px]">
                      {configuredPathInvalid
                        ? (currentSettings.gitExecutablePath ?? "")
                        : (gitEnvironment?.executablePath ?? t("settings.git.notFoundDescription"))}
                    </Muted>
                    {/* An invalid configured path is not a partial failure: local
                        and remote Git operations are both unavailable until it is
                        fixed or reset (docs/tasks.md P5-20). */}
                    {configuredPathInvalid && (
                      <p className="mt-1.5 text-[11px]" style={{ color: "var(--rust-ink)" }}>
                        {t("settings.git.invalidPathDescription")}
                      </p>
                    )}
                    {!configuredPathInvalid && gitEnvironment?.version && (
                      <Muted className="mt-1 block text-[11px]">
                        {t("settings.git.version", { version: gitEnvironment.version })} · {t(`settings.git.source.${gitEnvironment.executableSource ?? "path"}`)}
                      </Muted>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" disabled={gitPending} onClick={() => void chooseGitExecutable()}>
                        {t("settings.git.choose")}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={gitPending} onClick={() => void refreshGitEnvironment()}>
                        {t("settings.git.refresh")}
                      </Button>
                      {currentSettings.gitExecutablePath && (
                        <Button size="sm" variant="secondary" disabled={gitPending} onClick={() => void resetGitPath()}>
                          {t("settings.git.reset")}
                        </Button>
                      )}
                    </div>
                  </div>
                </SettingsGroup>

                {gitEnvironment && !configuredPathInvalid && (
                  <SettingsGroup title={t("settings.git.environment")}>
                    <div className="grid gap-2 text-[12px]">
                      <GitStatusRow
                        label={t("settings.git.credentialHelper")}
                        value={gitEnvironment.credentialHelpers.length > 0 ? t("settings.git.configured") : t("settings.git.notConfigured")}
                      />
                      {gitEnvironment.credentialHelpers.map((helper, index) => (
                        <Muted key={`${helper.source}-${index}`} className="break-all pl-2 text-[11px]">
                          {helper.value} · {helper.source}
                        </Muted>
                      ))}
                      <GitStatusRow
                        label={t("settings.git.sshAgent")}
                        value={gitEnvironment.sshAgentAvailable ? t("settings.git.available") : t("settings.git.unavailable")}
                      />
                      <GitStatusRow
                        label={t("settings.git.proxy")}
                        value={gitEnvironment.proxyConfigured ? t("settings.git.configured") : t("settings.git.notConfigured")}
                      />
                      <GitStatusRow
                        label={t("settings.git.askpass")}
                        value={gitEnvironment.askpassAvailable ? t("settings.git.available") : t("settings.git.unavailable")}
                        tone={gitEnvironment.askpassAvailable ? undefined : "var(--amber-ink)"}
                      />
                      {/* A missing sidecar is a packaging failure, and it only
                          shows up later as an unexplained authentication
                          failure. Say so here instead (docs/tasks.md P5-21). */}
                      {!gitEnvironment.askpassAvailable && (
                        <p className="pl-2 text-[11px]" style={{ color: "var(--amber-ink)" }}>
                          {t("settings.git.askpassMissingDescription")}
                        </p>
                      )}
                    </div>
                  </SettingsGroup>
                )}

                <SettingsGroup title={t("settings.git.connection")}>
                  <div className="flex gap-2">
                    <Select
                      value={connectionRepoId}
                      disabled={gitPending || repositories.length === 0}
                      onChange={(event) => setConnectionRepoId(event.target.value)}
                      className="min-w-0 flex-1"
                    >
                      {repositories.map((repository) => (
                        <option key={repository.id} value={repository.id}>{repository.name}</option>
                      ))}
                    </Select>
                    <Button size="sm" disabled={gitPending || !connectionRepoId} onClick={() => void runConnectionTest()}>
                      {t("settings.git.testConnection")}
                    </Button>
                  </div>
                  {repositories.length === 0 && <Muted className="text-[11px]">{t("settings.git.noRepositories")}</Muted>}
                  {connectionResult && (
                    <p className="text-[12px]" style={{ color: "var(--moss-ink)" }}>
                      {t("settings.git.connectionSuccess", {
                        duration: connectionResult.durationMs,
                        protocol: connectionResult.protocol.toUpperCase(),
                      })}
                    </p>
                  )}
                </SettingsGroup>

                {gitError && <p className="text-xs" style={{ color: "var(--rust-ink)" }}>{gitError}</p>}
                {gitDiagnostics && (
                  <details className="text-[11px]" style={{ color: "var(--slate)" }}>
                    <summary className="cursor-pointer">{t("settings.git.diagnostics")}</summary>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">{gitDiagnostics}</pre>
                  </details>
                )}
              </div>
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
      {confirmAutoFetch && (
        <ConfirmActionDialog
          title={t("settings.autoFetch.confirmTitle")}
          description={t("settings.autoFetch.confirmDescription")}
          confirmLabel={t("settings.autoFetch.confirmButton")}
          onClose={() => setConfirmAutoFetch(false)}
          onConfirm={() => {
            setConfirmAutoFetch(false);
            void saveSettings({ autoFetch: true }, "autoFetch");
          }}
        />
      )}
    </>
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

function GitStatusRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span style={{ color: "var(--slate)" }}>{label}</span>
      <span className="text-right" style={{ color: tone ?? "var(--ink)" }}>{value}</span>
    </div>
  );
}

function readDiagnostics(error: unknown): string | null {
  if (error && typeof error === "object" && "diagnostics" in error) {
    const value = error.diagnostics;
    return typeof value === "string" && value.trim() ? value : null;
  }
  return null;
}

function customIdeCommand(defaultIde: string | null) {
  return defaultIde?.startsWith(CUSTOM_IDE_PREFIX)
    ? defaultIde.slice(CUSTOM_IDE_PREFIX.length).trim()
    : "";
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
