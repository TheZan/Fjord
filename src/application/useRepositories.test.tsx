import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepositories } from "@/application/useRepositories";
import * as dialog from "@/infrastructure/dialog";
import { initI18n } from "@/infrastructure/i18n";
import * as tauriClient from "@/infrastructure/tauriClient";
import type { RepoStatusSummary, RepositoryEntry, Workspace } from "@/domain/workspace";

vi.mock("@/infrastructure/dialog", () => ({
  pickFolder: vi.fn(),
}));

vi.mock("@/infrastructure/tauriClient", () => ({
  addRepository: vi.fn(),
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  getWorkspaceStatus: vi.fn(),
  importRepositories: vi.fn(),
  listRepositories: vi.fn(),
  listWorkspaces: vi.fn(),
  removeRepository: vi.fn(),
  renameWorkspace: vi.fn(),
  reorderWorkspaces: vi.fn(),
}));

const workspaces: Workspace[] = [
  { id: "backend", name: "Backend", sortOrder: 1 },
  { id: "frontend", name: "Frontend", sortOrder: 0 },
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
    vi.mocked(tauriClient.createWorkspace).mockResolvedValue({
      id: "mobile",
      name: "Mobile",
      sortOrder: 2,
    });
  });

  it("loads workspaces, repositories, and cached status through the IPC boundary", async () => {
    const { result } = renderHook(() => useRepositories(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(tauriClient.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(tauriClient.listRepositories).toHaveBeenCalledWith("frontend");
    expect(tauriClient.getWorkspaceStatus).toHaveBeenCalledWith("backend");
    expect(result.current.workspaces.map((workspace) => workspace.id)).toEqual([
      "frontend",
      "backend",
    ]);
    expect(result.current.selectedWorkspaceId).toBe("frontend");
    expect(result.current.repositories.map((repo) => repo.id)).toEqual(["web"]);
    expect(result.current.statusByRepo.web.status.dirtyCount).toBe(3);
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
});
