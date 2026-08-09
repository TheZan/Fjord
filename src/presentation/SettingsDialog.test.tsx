import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsDialog } from "@/presentation/SettingsDialog";

const getSettings = vi.fn();
const getGitEnvironment = vi.fn();
const testGitConnection = vi.fn();

vi.mock("@/infrastructure/tauriClient", () => ({
  getSettings: (...args: unknown[]) => getSettings(...args),
  updateSettings: vi.fn(),
  getGitEnvironment: (...args: unknown[]) => getGitEnvironment(...args),
  selectGitExecutable: vi.fn(),
  resetGitExecutable: vi.fn(),
  testGitConnection: (...args: unknown[]) => testGitConnection(...args),
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
        "settings.sections.git": "Git",
        "settings.git.version": String(values?.version ?? ""),
        "settings.git.testConnection": "Test connection",
        "settings.git.connectionSuccess": `${String(values?.protocol ?? "")} ${String(values?.duration ?? "")} ms`,
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
});
