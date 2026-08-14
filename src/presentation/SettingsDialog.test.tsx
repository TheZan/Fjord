import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateCoordinator } from "@/application/update/UpdateCoordinator";
import { SettingsDialog } from "@/presentation/SettingsDialog";

const getSettings = vi.fn();
const getGitEnvironment = vi.fn();
const testGitConnection = vi.fn();
const revealLogFolder = vi.fn();
const checkForUpdate = vi.fn();

vi.mock("@/infrastructure/tauriClient", () => ({
  getSettings: (...args: unknown[]) => getSettings(...args),
  updateSettings: vi.fn(),
  getGitEnvironment: (...args: unknown[]) => getGitEnvironment(...args),
  selectGitExecutable: vi.fn(),
  resetGitExecutable: vi.fn(),
  testGitConnection: (...args: unknown[]) => testGitConnection(...args),
  revealLogFolder: (...args: unknown[]) => revealLogFolder(...args),
}));

vi.mock("@/infrastructure/updater", () => ({
  checkForUpdate: (...args: unknown[]) => checkForUpdate(...args),
  downloadAndInstallUpdate: vi.fn(),
  relaunchApp: vi.fn(),
}));

vi.mock("@/infrastructure/dialog", () => ({ pickFile: vi.fn() }));
vi.mock("@/infrastructure/theme/ThemeProvider", () => ({
  useTheme: () => ({ choice: "system", setChoice: vi.fn() }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { changeLanguage: vi.fn() },
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        "settings.sections.general": "General",
        "settings.sections.git": "Git",
        "settings.sections.tools": "Tools",
        "settings.sections.about": "About",
        "settings.appearance.label": "Appearance",
        "settings.locale.interfaceLanguage": "Interface language",
        "settings.theme.light": "Light",
        "settings.theme.dark": "Dark",
        "settings.theme.system": "System",
        "settings.git.version": String(values?.version ?? ""),
        "settings.git.testConnection": "Test connection",
        "settings.git.connectionSuccess": `${String(values?.protocol ?? "")} ${String(values?.duration ?? "")} ms`,
        "settings.about.version": "Version 0.1.0",
        "settings.about.revealLogs": "Reveal log folder",
        "settings.about.updates": "Updates",
        "settings.about.checkForUpdate": "Check for updates",
        "settings.about.checkingForUpdates": "Checking…",
        "settings.about.upToDate": `Fjord ${String(values?.version ?? "")} is the latest version.`,
        "settings.about.checkFailed": "Could not check for updates.",
        "app.title": "Fjord",
      };
      return labels[key] ?? key;
    },
  }),
}));

describe("SettingsDialog Git section", () => {
  beforeEach(() => {
    getSettings.mockResolvedValue({
      locale: "en",
      theme: "system",
      defaultIde: null,
      autoFetch: false,
      performanceDiagnostics: false,
      gitExecutablePath: null,
    });
    getGitEnvironment.mockResolvedValue({
      executablePath: "C:/Program Files/Git/cmd/git.exe",
      version: "2.50.1.windows.1",
      executableSource: "standard-location",
      configuredPathValid: true,
      credentialHelpers: [{ value: "manager", source: "file:C:/Users/test/.gitconfig" }],
      sshCommand: null,
      sshAgentAvailable: true,
      proxyConfigured: false,
      askpassAvailable: true,
    });
    testGitConnection.mockResolvedValue({
      success: true,
      durationMs: 12,
      remote: "origin",
      protocol: "https",
      referenceCount: 3,
    });
    revealLogFolder.mockResolvedValue(undefined);
    checkForUpdate.mockReset();
    updateCoordinator.close();
  });

  it("uses the compact four-section product structure without automatic fetch", async () => {
    render(<SettingsDialog repositories={[]} onClose={vi.fn()} />);

    expect(await screen.findByText("Interface language")).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "settings.title" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "General",
      "Git",
      "Tools",
      "About",
    ]);
    expect(within(navigation).queryByRole("button", { name: "Sync" })).not.toBeInTheDocument();
    expect(screen.queryByText("Fetch changes automatically")).not.toBeInTheDocument();
  });

  // A section whose whole body was one row of three buttons read as an empty
  // screen; language and theme are both once-per-install choices.
  it("keeps language and theme together in General", async () => {
    render(<SettingsDialog repositories={[]} onClose={vi.fn()} />);

    expect(await screen.findByText("Interface language")).toBeInTheDocument();
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    for (const theme of ["Light", "Dark", "System"]) {
      expect(screen.getByRole("button", { name: theme })).toBeInTheDocument();
    }
  });

  it("orders Tools as editor, custom command, then performance diagnostics", async () => {
    render(<SettingsDialog repositories={[]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Tools" }));

    const groups = await screen.findAllByText(
      /settings\.defaultIde\.(label|custom)$|settings\.performanceDiagnostics\.label/,
    );
    expect(groups.map((node) => node.textContent)).toEqual([
      "settings.defaultIde.label",
      "settings.defaultIde.custom",
      "settings.performanceDiagnostics.label",
    ]);
  });

  it("shows diagnostics and can test a repository connection", async () => {
    render(
      <SettingsDialog
        repositories={[{
          id: "repo-1",
          workspaceId: "workspace-1",
          name: "Fjord",
          path: "C:/repos/Fjord",
          sortOrder: 0,
        }]}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Git" }));
    expect(await screen.findByText(/2\.50\.1\.windows\.1/)).toBeInTheDocument();
    expect(screen.getByText(/manager/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(testGitConnection).toHaveBeenCalledWith("repo-1"));
    expect(await screen.findByText(/HTTPS.*12 ms/)).toBeInTheDocument();
  });

  // P5-20: a configured path that cannot run is its own state. Reporting it as
  // "Git found" with an empty environment, or as a bare error with no path in
  // it, both leave the user unable to tell what to fix.
  it("names the invalid configured executable instead of reporting an environment", async () => {
    getSettings.mockResolvedValue({
      locale: "en",
      theme: "system",
      defaultIde: null,
      autoFetch: false,
      performanceDiagnostics: false,
      gitExecutablePath: "C:/nowhere/git.exe",
    });
    getGitEnvironment.mockResolvedValue({
      executablePath: null,
      version: null,
      executableSource: null,
      configuredPathValid: false,
      credentialHelpers: [],
      sshCommand: null,
      sshAgentAvailable: false,
      proxyConfigured: false,
      askpassAvailable: true,
    });

    render(<SettingsDialog repositories={[]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Git" }));

    expect(await screen.findByText("settings.git.invalidPath")).toBeInTheDocument();
    expect(screen.getByText("settings.git.invalidPathDescription")).toBeInTheDocument();
    expect(screen.getByText("C:/nowhere/git.exe")).toBeInTheDocument();
    expect(screen.queryByText("settings.git.found")).not.toBeInTheDocument();
    // The authentication environment belongs to a Git that runs; showing its
    // empty defaults here would read as "no credential helper configured".
    expect(screen.queryByText("settings.git.environment")).not.toBeInTheDocument();
    // Resetting the path stays reachable — it is the way out of this state.
    expect(screen.getByRole("button", { name: "settings.git.reset" })).toBeInTheDocument();
  });

  // P5-21: a missing sidecar used to be a log line only, so the user met it as
  // an authentication failure on their first prompt with nothing to connect it
  // to.
  it("reports a missing askpass sidecar in the authentication environment", async () => {
    getGitEnvironment.mockResolvedValue({
      executablePath: "/usr/bin/git",
      version: "2.51.0",
      executableSource: "path",
      configuredPathValid: true,
      credentialHelpers: [],
      sshCommand: null,
      sshAgentAvailable: false,
      proxyConfigured: false,
      askpassAvailable: false,
    });

    render(<SettingsDialog repositories={[]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Git" }));

    expect(await screen.findByText("settings.git.askpass")).toBeInTheDocument();
    expect(screen.getByText("settings.git.askpassMissingDescription")).toBeInTheDocument();
  });

  it("shows practical app information and reveals the application log folder", async () => {
    render(<SettingsDialog repositories={[]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(await screen.findByText("Fjord")).toBeInTheDocument();
    expect(screen.getByText("Version 0.1.0")).toBeInTheDocument();
    expect(screen.queryByText(/not just another Git client/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reveal log folder" }));
    await waitFor(() => expect(revealLogFolder).toHaveBeenCalledOnce());
  });

  it("checks for updates through the shared updater coordinator and shows a compact result", async () => {
    checkForUpdate.mockResolvedValue(null);
    render(<SettingsDialog repositories={[]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "About" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));

    await waitFor(() => expect(checkForUpdate).toHaveBeenCalledOnce());
    expect(await screen.findByText("Fjord 0.1.0 is the latest version.")).toBeInTheDocument();
  });

  it("shows the ownership refusal diagnostic and safe-directory command", async () => {
    render(<SettingsDialog repositories={[]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Git" }));

    expect(await screen.findByText("settings.git.repositoryOwnership")).toBeInTheDocument();
    expect(screen.getByText("settings.git.repositoryOwnershipDescription")).toBeInTheDocument();
    expect(screen.getByText(/git config --global --add safe\.directory/)).toBeInTheDocument();
    expect(screen.getByText("settings.git.repositoryOwnershipWarning")).toBeInTheDocument();
  });
});
