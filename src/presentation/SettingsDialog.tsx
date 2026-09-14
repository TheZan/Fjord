import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import packageInfo from "../../package.json";
import logoUrl from "../../assets/logo/fjord-mark.svg";
import { userErrorMessage } from "@/application/errorMessage";
import { updateCoordinator } from "@/application/update/UpdateCoordinator";
import { isBusyPhase } from "@/application/update/updateModel";
import { useUpdateState } from "@/application/update/useUpdateState";
import { pickFile } from "@/infrastructure/dialog";
import { setLocale } from "@/infrastructure/i18n";
import { useTheme } from "@/infrastructure/theme/ThemeProvider";
import {
  getGitEnvironment,
  getSettings,
  resetGitExecutable,
  revealLogFolder,
  selectGitExecutable,
  testGitConnection,
  updateSettings,
} from "@/infrastructure/tauriClient";
import { SUPPORTED_LOCALES } from "@/locales/registry";
import { useInteractionCommit } from "@/presentation/performance";
import { Button, GroupLabel, Input, Muted, Select } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";
import type {
  GitConnectionTestResult,
  GitEnvironmentInfo,
  Settings,
  Theme,
} from "@/domain/settings";
import type { RepositoryEntry } from "@/domain/workspace";

const THEME_CHOICES: Theme[] = ["light", "dark", "system"];
const CUSTOM_IDE_PREFIX = "custom:";

type SettingsSection = "general" | "git" | "tools" | "about";

const SECTION_CHOICES: SettingsSection[] = ["general", "git", "tools", "about"];
const DEFAULT_SETTINGS: Settings = {
  locale: "en",
  theme: "system",
  defaultIde: null,
  autoFetch: false,
  performanceDiagnostics: false,
  gitExecutablePath: null,
  diffTool: null,
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
  useInteractionCommit();
  const { t, i18n } = useTranslation();
  const updateState = useUpdateState();
  const updateActionDisabled = isBusyPhase(updateState.phase) || updateState.phase === "available";
  const { t: tw } = useTranslation("workspace");
  const { choice, setChoice } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customIde, setCustomIde] = useState("");
  const [diffToolInput, setDiffToolInput] = useState("");
  const [gitEnvironment, setGitEnvironment] = useState<GitEnvironmentInfo | null>(null);
  const [gitPending, setGitPending] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitDiagnostics, setGitDiagnostics] = useState<string | null>(null);
  const [connectionResult, setConnectionResult] = useState<GitConnectionTestResult | null>(null);
  const [connectionRepoId, setConnectionRepoId] = useState(repositories[0]?.id ?? "");
  const [logFolderPending, setLogFolderPending] = useState(false);
  const [logFolderError, setLogFolderError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, onClose);

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
        setDiffToolInput(loaded.diffTool ?? "");
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

  function commitDiffTool() {
    const trimmed = diffToolInput.trim();
    setDiffToolInput(trimmed);
    if (trimmed === (currentSettings.diffTool ?? "")) return;
    void saveSettings({ diffTool: trimmed ? trimmed : null }, "diffTool");
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

  async function revealLogs() {
    setLogFolderPending(true);
    setLogFolderError(null);
    try {
      await revealLogFolder();
    } catch (reason) {
      setLogFolderError(userErrorMessage(reason));
    } finally {
      setLogFolderPending(false);
    }
  }

  const selectedIde = currentSettings.defaultIde?.startsWith(CUSTOM_IDE_PREFIX)
    ? "custom"
    : currentSettings.defaultIde;
  const selectedLocale = SUPPORTED_LOCALES.some((locale) => locale.code === currentSettings.locale)
    ? currentSettings.locale
    : DEFAULT_SETTINGS.locale;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      style={{ background: "rgba(8, 12, 16, 0.45)" }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={tw("settings.title")}
        tabIndex={-1}
        className="desktop-popover flex h-[min(680px,78vh)] w-[720px] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg border"
        style={{
          borderWidth: "0.5px",
          borderColor: "var(--hairline-strong)",
          background: "var(--paper)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <aside
          className="w-36 shrink-0 border-r px-2.5 py-3"
          style={{ borderRightWidth: "0.5px", borderColor: "var(--hairline)" }}
        >
          <h2 className="px-2 pb-3 text-[14px] font-medium">{tw("settings.title")}</h2>
          <nav aria-label={tw("settings.title")} className="flex flex-col gap-0.5">
            {SECTION_CHOICES.map((section) => (
              <button
                key={section}
                type="button"
                data-selected={activeSection === section}
                aria-current={activeSection === section ? "page" : undefined}
                onClick={() => setActiveSection(section)}
                className="interactive-row rounded-md px-2 py-1.5 text-left text-[12px]"
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
            className="flex min-h-12 items-center justify-between border-b px-5 py-2.5"
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

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeSection === "general" && (
              <div className="flex flex-col gap-4">
                <SettingsGroup
                  title={t("settings.locale.label")}
                  description={t("settings.locale.description")}
                >
                  <SettingsPanel className="flex items-center justify-between gap-5">
                    <span className="text-[12px]" style={{ color: "var(--slate)" }}>
                      {t("settings.locale.interfaceLanguage")}
                    </span>
                    <Select
                      value={selectedLocale}
                      disabled={pendingKey === "locale"}
                      onChange={(event) => void chooseLocale(event.target.value)}
                      className="w-52 max-w-full"
                    >
                      {SUPPORTED_LOCALES.map((locale) => (
                        <option key={locale.code} value={locale.code}>
                          {locale.label}
                        </option>
                      ))}
                    </Select>
                  </SettingsPanel>
                </SettingsGroup>

                {/* Theme is the only appearance preference, so it lives with the
                    other once-per-install choices instead of owning a section
                    whose panel would hold a single row of three buttons. */}
                <SettingsGroup
                  title={t("settings.appearance.label")}
                  description={t("settings.theme.description")}
                >
                  <SettingsPanel className="grid grid-cols-3 gap-1.5">
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
                  </SettingsPanel>
                </SettingsGroup>
              </div>
            )}

            {activeSection === "git" && (
              <div className="flex flex-col gap-4">
                <SettingsGroup
                  title={t("settings.git.executable")}
                  description={t("settings.git.executableDescription")}
                >
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
                  <SettingsGroup
                    title={t("settings.git.environment")}
                    description={t("settings.git.environmentDescription")}
                  >
                    <SettingsPanel className="grid gap-2 text-[12px]">
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
                    </SettingsPanel>
                  </SettingsGroup>
                )}

                <SettingsGroup
                  title={t("settings.git.repositoryOwnership")}
                  description={t("settings.git.repositoryOwnershipSummary")}
                >
                  <div
                    className="rounded-md border p-3 text-[11px] leading-4"
                    style={{ borderWidth: "0.5px", borderColor: "var(--hairline)" }}
                  >
                    <p>{t("settings.git.repositoryOwnershipDescription")}</p>
                    <code
                      className="mt-2 block overflow-x-auto rounded px-2 py-1.5"
                      style={{ background: "var(--page-bg)", color: "var(--ink)" }}
                    >
                      {"git config --global --add safe.directory \"<repository-path>\""}
                    </code>
                    <Muted className="mt-2 block">
                      {t("settings.git.repositoryOwnershipWarning")}
                    </Muted>
                  </div>
                </SettingsGroup>

                <SettingsGroup
                  title={t("settings.git.connection")}
                  description={t("settings.git.connectionDescription")}
                >
                  <SettingsPanel className="flex flex-col gap-2">
                    <div className="flex gap-2">
                      <Select
                        value={connectionRepoId}
                        disabled={gitPending || repositories.length === 0}
                        onChange={(event) => setConnectionRepoId(event.target.value)}
                        className="min-w-0 flex-1"
                      >
                        {repositories.map((repository) => (
                          <option key={repository.id} value={repository.id}>
                            {repository.name}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        disabled={gitPending || !connectionRepoId}
                        onClick={() => void runConnectionTest()}
                      >
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
                  </SettingsPanel>
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

            {activeSection === "tools" && (
              <div className="flex flex-col gap-4">
                <SettingsGroup
                  title={t("settings.defaultIde.label")}
                  description={t("settings.defaultIde.description")}
                >
                  <SettingsPanel className="grid grid-cols-3 gap-1.5">
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
                  </SettingsPanel>
                </SettingsGroup>

                <SettingsGroup
                  title={t("settings.defaultIde.custom")}
                  description={t("settings.defaultIde.customDescription")}
                >
                  <SettingsPanel className="flex flex-col gap-2">
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
                  </SettingsPanel>
                </SettingsGroup>

                <SettingsGroup title={t("settings.diffTool.label")}>
                  <SettingsPanel className="flex flex-col gap-2">
                    <Input
                      value={diffToolInput}
                      onChange={(event) => setDiffToolInput(event.target.value)}
                      onBlur={commitDiffTool}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      placeholder={t("settings.diffTool.auto")}
                      disabled={pendingKey === "diffTool"}
                      className="min-w-0 flex-1"
                    />
                    <Muted className="text-[11px]">{t("settings.diffTool.invalidName")}</Muted>
                  </SettingsPanel>
                </SettingsGroup>

                <SettingsGroup title={t("settings.performanceDiagnostics.label")}>
                  <div
                    className="flex items-center justify-between gap-5 rounded-md border px-3 py-3"
                    style={{ borderWidth: "0.5px", borderColor: "var(--hairline)" }}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>
                        {t("settings.performanceDiagnostics.title")}
                      </div>
                      <Muted className="mt-0.5 block max-w-md text-[11px] leading-4">
                        {t("settings.performanceDiagnostics.description")}
                      </Muted>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={currentSettings.performanceDiagnostics}
                      aria-label={t("settings.performanceDiagnostics.title")}
                      disabled={pendingKey === "performanceDiagnostics"}
                      className="interactive-control relative h-5 w-9 shrink-0 rounded-full disabled:opacity-45"
                      style={{
                        background: currentSettings.performanceDiagnostics
                          ? "var(--fjord)"
                          : "var(--hairline-strong)",
                      }}
                      onClick={() =>
                        void saveSettings(
                          { performanceDiagnostics: !currentSettings.performanceDiagnostics },
                          "performanceDiagnostics",
                        )
                      }
                    >
                      <span
                        className="absolute top-0.5 h-4 w-4 rounded-full transition-transform"
                        style={{
                          left: "2px",
                          background: "var(--paper)",
                          transform: currentSettings.performanceDiagnostics
                            ? "translateX(16px)"
                            : "translateX(0)",
                        }}
                      />
                    </button>
                  </div>
                </SettingsGroup>
              </div>
            )}

            {activeSection === "about" && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3 py-1">
                  <img src={logoUrl} alt="" className="h-10 w-10 shrink-0" />
                  <div>
                    <div className="text-[15px] font-semibold">{t("app.title")}</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: "var(--mist)" }}>
                      {t("settings.about.version", { version: packageInfo.version })}
                    </div>
                  </div>
                </div>
                <SettingsGroup title={t("settings.about.updates")}>
                  <SettingsPanel className="flex flex-col gap-2">
                    <Button
                      size="sm"
                      disabled={updateActionDisabled}
                      onClick={() => void updateCoordinator.checkManually()}
                    >
                      {updateState.phase === "checking"
                        ? t("settings.about.checkingForUpdates")
                        : t("settings.about.checkForUpdate")}
                    </Button>
                    {updateState.phase === "up-to-date" && (
                      <p className="text-[12px]" style={{ color: "var(--moss-ink)" }}>
                        {t("settings.about.upToDate", { version: packageInfo.version })}
                      </p>
                    )}
                    {updateState.phase === "check-failed" && (
                      <p role="alert" className="text-[12px]" style={{ color: "var(--rust-ink)" }}>
                        {t("settings.about.checkFailed")}
                      </p>
                    )}
                  </SettingsPanel>
                </SettingsGroup>

                <SettingsGroup
                  title={t("settings.about.diagnostics")}
                  description={t("settings.about.logsDescription")}
                >
                  <SettingsPanel>
                    <Button size="sm" disabled={logFolderPending} onClick={() => void revealLogs()}>
                      {logFolderPending
                        ? t("settings.about.revealingLogs")
                        : t("settings.about.revealLogs")}
                    </Button>
                    {logFolderError && <p role="alert" className="mt-2 text-[11px]" style={{ color: "var(--rust-ink)" }}>{logFolderError}</p>}
                  </SettingsPanel>
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

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <GroupLabel>{title}</GroupLabel>
        {description && (
          <Muted className="mt-0.5 block max-w-xl text-[11px] leading-4">{description}</Muted>
        )}
      </div>
      {children}
    </div>
  );
}

function SettingsPanel({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2.5 ${className}`}
      style={{ borderWidth: "0.5px", borderColor: "var(--hairline)" }}
    >
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
