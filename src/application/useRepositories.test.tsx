import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepositories } from "@/application/useRepositories";
import * as dialog from "@/infrastructure/dialog";
import { initI18n } from "@/infrastructure/i18n";
import * as tauriClient from "@/infrastructure/tauriClient";
import type { RepoHealth, RepoStatusSummary, RepositoryEntry, Workspace } from "@/domain/workspace";

vi.mock("@/infrastructure/dialog", () => ({
  pickFolder: vi.fn(),
}));

vi.mock("@/infrastructure/tauriClient", () => ({
  addRepository: vi.fn(),
  cloneRepository: vi.fn(),
  createRepository: vi.fn(),
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  getWorkspaceStatus: vi.fn(),
  getWorkspaceHealth: vi.fn(),
  importRepositories: vi.fn(),
  listRepositories: vi.fn(),
  listWorkspaces: vi.fn(),
  removeRepository: vi.fn(),
  renameWorkspace: vi.fn(),
  setWorkspaceExpectedBranch: vi.fn(),
  reorderWorkspaces: vi.fn(),
}));

const workspaces: Workspace[] = [
  { id: "backend", name: "Backend", sortOrder: 1, expectedBranch: null },
  { id: "frontend", name: "Frontend", sortOrder: 0, expectedBranch: null },
];

const repositoriesByWorkspace: Record<string, RepositoryEntry[]> = {
  backend: [
    {
      id: "api",
      workspaceId: "backend",
      name: "api",
      path: "/dev/api",
      sortOrder: 0,
    },
  ],
  frontend: [
    {
      id: "web",
      workspaceId: "frontend",
      name: "web",
      path: "/dev/web",
      sortOrder: 0,
    },
  ],
  mobile: [],
};

const statusByWorkspace: Record<string, RepoStatusSummary[]> = {
  backend: [
    {
      repoId: "api",
      status: { branch: "main", ahead: 0, behind: 1, dirtyCount: 0, hasConflict: false },
      lastSyncedAt: null,
    },
  ],
  frontend: [
    {
      repoId: "web",
      status: { branch: "develop", ahead: 2, behind: 0, dirtyCount: 3, hasConflict: false },
      lastSyncedAt: null,
    },
  ],
  mobile: [],
};

const healthByWorkspace: Record<string, RepoHealth[]> = {
  backend: [
    { repoId: "api", conditions: [{ kind: "behind", count: 1 }], needsAttention: false, asOf: "1970-01-01T00:00:00Z" },
  ],
  frontend: [
    { repoId: "web", conditions: [{ kind: "ahead", count: 2 }, { kind: "dirty", count: 3 }], needsAttention: false, asOf: "1970-01-01T00:00:00Z" },
  ],
  mobile: [],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useRepositories", () => {
  beforeEach(() => {
    vi.mocked(tauriClient.listWorkspaces).mockResolvedValue(workspaces);
    vi.mocked(tauriClient.listRepositories).mockImplementation(
      async (workspaceId) => repositoriesByWorkspace[workspaceId] ?? [],
    );
    vi.mocked(tauriClient.getWorkspaceStatus).mockImplementation(
      async (workspaceId) => statusByWorkspace[workspaceId] ?? [],
    );
    vi.mocked(tauriClient.getWorkspaceHealth).mockImplementation(
      async (workspaceId) => healthByWorkspace[workspaceId] ?? [],
    );
    vi.mocked(tauriClient.createWorkspace).mockResolvedValue({
      id: "mobile",
      name: "Mobile",
      sortOrder: 2,
      expectedBranch: null,
    });
  });

  it("loads workspaces, repositories, and cached status through the IPC boundary", async () => {
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(tauriClient.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(tauriClient.listRepositories).toHaveBeenCalledWith("frontend");
    expect(tauriClient.getWorkspaceStatus).toHaveBeenCalledWith("backend");
    expect(tauriClient.getWorkspaceHealth).toHaveBeenCalledWith("backend");
    expect(result.current.workspaces.map((workspace) => workspace.id)).toEqual([
      "frontend",
      "backend",
    ]);
    expect(result.current.selectedWorkspaceId).toBe("frontend");
    expect(result.current.repositories.map((repo) => repo.id)).toEqual(["web"]);
    expect(result.current.statusByRepo.web.status.dirtyCount).toBe(3);
    expect(result.current.healthByRepo.web.needsAttention).toBe(false);
  });

  it("creates a workspace through a mutation and selects it", async () => {
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      const created = await result.current.createWorkspace("  Mobile  ");
      expect(created?.id).toBe("mobile");
    });

    expect(tauriClient.createWorkspace).toHaveBeenCalledWith("Mobile");
    await waitFor(() => expect(result.current.selectedWorkspaceId).toBe("mobile"));
    expect(result.current.workspaces.map((workspace) => workspace.id)).toEqual([
      "frontend",
      "backend",
      "mobile",
    ]);
  });

  it("reorders workspaces by drop target", async () => {
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.moveWorkspaceTo("backend", "frontend");
    });

    expect(tauriClient.reorderWorkspaces).toHaveBeenCalledWith(["backend", "frontend"]);
    expect(result.current.workspaces.map((workspace) => workspace.id)).toEqual([
      "backend",
      "frontend",
    ]);
  });

  it("publishes one cloned repository into the workspace query", async () => {
    const cloned: RepositoryEntry = {
      id: "fjord",
      workspaceId: "frontend",
      name: "fjord",
      path: "/dev/fjord",
      sortOrder: 1,
    };
    vi.mocked(tauriClient.cloneRepository).mockReturnValue({
      operationId: "clone:1",
      promise: Promise.resolve({ repository: cloned }),
    });
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const request = {
      workspaceId: "frontend",
      url: "https://example.test/fjord.git",
      destinationParent: "/dev",
      directoryName: "fjord",
      branch: null,
    };
    await act(async () => result.current.cloneRepository(request).promise);

    expect(tauriClient.cloneRepository).toHaveBeenCalledWith(request);
    await waitFor(() =>
      expect(result.current.repositories.filter((repo) => repo.id === "fjord")).toHaveLength(1),
    );
  });

  it("publishes one created repository into the workspace query", async () => {
    const created: RepositoryEntry = {
      id: "new-local",
      workspaceId: "frontend",
      name: "new-local",
      path: "/dev/new-local",
      sortOrder: 1,
    };
    vi.mocked(tauriClient.createRepository).mockResolvedValue({ repository: created });
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const request = {
      workspaceId: "frontend",
      destinationParent: "/dev",
      directoryName: "new-local",
      initialBranch: "main",
    };
    await act(async () => result.current.createRepository(request));

    expect(tauriClient.createRepository).toHaveBeenCalledWith(request);
    await waitFor(() =>
      expect(result.current.repositories.filter((repo) => repo.id === "new-local")).toHaveLength(1),
    );
  });

  it("shows a localized dismissible error when a repository is added twice", async () => {
    await initI18n("ru");
    vi.mocked(dialog.pickFolder).mockResolvedValue("C:\\dev\\web");
    vi.mocked(tauriClient.addRepository).mockRejectedValue({
      code: "repository_already_added",
      message: "UNIQUE constraint failed: repositories.workspace_id, repositories.path",
    });
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.openRepository());

    expect(result.current.error).toBe(
      "Этот репозиторий уже добавлен в выбранное рабочее пространство.",
    );
    expect(result.current.error).not.toContain("UNIQUE");

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("reports picker cancellation so onboarding can remain open", async () => {
    vi.mocked(tauriClient.addRepository).mockClear();
    vi.mocked(tauriClient.importRepositories).mockClear();
    vi.mocked(dialog.pickFolder).mockResolvedValue(null);
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(await result.current.openRepository()).toBe(false);
      expect(await result.current.importRepositories()).toBeNull();
    });

    expect(tauriClient.addRepository).not.toHaveBeenCalled();
    expect(tauriClient.importRepositories).not.toHaveBeenCalled();
  });
  it("refreshes the workspace row and its health after an expected-branch change", async () => {
    const updated: Workspace = {
      id: "backend",
      name: "Backend",
      sortOrder: 1,
      expectedBranch: "develop",
    };
    vi.mocked(tauriClient.setWorkspaceExpectedBranch).mockResolvedValue(updated);
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const healthCallsBefore = vi.mocked(tauriClient.getWorkspaceHealth).mock.calls.length;
    const repositoryCallsBefore = vi.mocked(tauriClient.listRepositories).mock.calls.length;
    const statusCallsBefore = vi.mocked(tauriClient.getWorkspaceStatus).mock.calls.length;

    await act(async () => result.current.setWorkspaceExpectedBranch("backend", "develop"));

    expect(tauriClient.setWorkspaceExpectedBranch).toHaveBeenCalledExactlyOnceWith(
      "backend",
      "develop",
    );
    // The workspace query now carries the persisted value, so the summary can
    // render it without a restart...
    await waitFor(() =>
      expect(
        result.current.workspaces.find((workspace) => workspace.id === "backend")?.expectedBranch,
      ).toBe("develop"),
    );
    // ...and health is recomputed, because WrongBranch depends on it.
    await waitFor(() =>
      expect(vi.mocked(tauriClient.getWorkspaceHealth).mock.calls.length).toBeGreaterThan(
        healthCallsBefore,
      ),
    );
    // Repository lists and statuses are untouched: expected branch changes no
    // repository state.
    expect(vi.mocked(tauriClient.listRepositories).mock.calls.length).toBe(repositoryCallsBefore);
    expect(vi.mocked(tauriClient.getWorkspaceStatus).mock.calls.length).toBe(statusCallsBefore);
  });

  it("surfaces an expected-branch validation failure to the caller", async () => {
    vi.mocked(tauriClient.setWorkspaceExpectedBranch).mockRejectedValue({
      code: "expected_branch_invalid",
      message: "invalid setting: expected_branch_invalid",
    });
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(
        result.current.setWorkspaceExpectedBranch("backend", "not a branch"),
      ).rejects.toMatchObject({ code: "expected_branch_invalid" });
    });

    // The dialog owns this error; the app-level strip must stay clean.
    expect(result.current.error).toBeNull();
  });
});
