import { beforeEach, describe, expect, it, vi } from "vitest";

const getUiState = vi.fn();
const updateUiState = vi.fn();

vi.mock("@/infrastructure/tauriClient", () => ({
  getUiState: (...args: unknown[]) => getUiState(...args),
  updateUiState: (...args: unknown[]) => updateUiState(...args),
}));

describe("UI state migration", () => {
  beforeEach(() => {
    vi.resetModules();
    getUiState.mockReset();
    updateUiState.mockReset();
    localStorage.clear();
  });

  it("moves legacy pane widths to SQLite and removes the old key", async () => {
    getUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    });
    updateUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: 276, inspectorWidth: 410, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    });
    localStorage.setItem("fjord:repo-layout:v1", JSON.stringify({ left: 276, right: 410 }));
    const { loadUiState } = await import("@/infrastructure/uiState");

    const state = await loadUiState();

    expect(updateUiState).toHaveBeenCalledWith({
      sidebar: null,
      repo: { treeWidth: 276, inspectorWidth: 410, diffMode: null, fileViewMode: null },
      selection: null,
      overview: null,
    });
    expect(state.repo).toEqual({
      treeWidth: 276,
      inspectorWidth: 410,
      diffMode: "unified",
      fileViewMode: "path",
    });
    expect(localStorage.getItem("fjord:repo-layout:v1")).toBeNull();
  });

  it("keeps the legacy key when persistence fails so migration can retry", async () => {
    getUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    });
    updateUiState.mockRejectedValue(new Error("database locked"));
    localStorage.setItem("fjord:repo-layout:v1", JSON.stringify({ left: 276, right: 410 }));
    const { loadUiState } = await import("@/infrastructure/uiState");

    await expect(loadUiState()).rejects.toThrow("database locked");
    expect(localStorage.getItem("fjord:repo-layout:v1")).not.toBeNull();
  });

  it("persists sidebar width as an isolated partial patch", async () => {
    const initial = {
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: 240, inspectorWidth: 384, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    };
    getUiState.mockResolvedValue(initial);
    updateUiState.mockResolvedValue({ ...initial, sidebar: { width: 312, collapsedWorkspaces: [] } });
    const { saveSidebarWidth } = await import("@/infrastructure/uiState");

    await saveSidebarWidth(312);

    expect(updateUiState).toHaveBeenCalledWith({
      sidebar: { width: 312, collapsedWorkspaces: null },
      repo: null,
      selection: null,
      overview: null,
    });
  });

  it("persists selection, modes, collapsed workspaces, and overview filters as isolated patches", async () => {
    const initial = {
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    };
    getUiState.mockResolvedValue(initial);
    updateUiState.mockResolvedValue(initial);
    const { saveCollapsedWorkspaces, saveOverviewFilters, saveRepoModes, saveSelection } =
      await import("@/infrastructure/uiState");

    await saveCollapsedWorkspaces(["workspace-2"]);
    await saveSelection("workspace-1", "repo-1");
    await saveRepoModes("split", "tree");
    await saveOverviewFilters(["attention"]);

    expect(updateUiState).toHaveBeenNthCalledWith(1, {
      sidebar: { width: null, collapsedWorkspaces: ["workspace-2"] },
      repo: null,
      selection: null,
      overview: null,
    });
    expect(updateUiState).toHaveBeenNthCalledWith(2, {
      sidebar: null,
      repo: null,
      selection: { workspaceId: "workspace-1", repositoryId: "repo-1" },
      overview: null,
    });
    expect(updateUiState).toHaveBeenNthCalledWith(3, {
      sidebar: null,
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "split", fileViewMode: "tree" },
      selection: null,
      overview: null,
    });
    expect(updateUiState).toHaveBeenNthCalledWith(4, {
      sidebar: null,
      repo: null,
      selection: null,
      overview: { filters: ["attention"] },
    });
  });
});
