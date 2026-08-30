import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOverviewFilters } from "@/application/useOverviewFilters";

const loadUiState = vi.fn();
const saveOverviewFilters = vi.fn();

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: (...args: unknown[]) => loadUiState(...args),
  saveOverviewFilters: (...args: unknown[]) => saveOverviewFilters(...args),
}));

function state(filters: string[]) {
  return {
    version: 1,
    sidebar: { width: null, collapsedWorkspaces: [] },
    repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
    selection: { workspaceId: null, repositoryId: null },
    overview: { filters },
  };
}

describe("useOverviewFilters", () => {
  beforeEach(() => {
    loadUiState.mockReset().mockResolvedValue(state([]));
    saveOverviewFilters.mockReset().mockResolvedValue(undefined);
  });

  it("restores legacy Attention and Behind values", async () => {
    loadUiState.mockResolvedValue(state(["attention", "behind"]));
    const { result } = renderHook(() => useOverviewFilters());

    await waitFor(() => expect([...result.current.filters]).toEqual(["attention", "behind"]));
  });

  it("persists every toggle and clear in canonical order", async () => {
    const { result } = renderHook(() => useOverviewFilters());
    await waitFor(() => expect(loadUiState).toHaveBeenCalledOnce());

    act(() => result.current.toggleFilter("wrongBranch"));
    act(() => result.current.toggleFilter("dirty"));
    act(() => result.current.toggleFilter("conflicts"));

    expect(saveOverviewFilters).toHaveBeenNthCalledWith(1, ["wrongBranch"]);
    expect(saveOverviewFilters).toHaveBeenNthCalledWith(2, ["dirty", "wrongBranch"]);
    expect(saveOverviewFilters).toHaveBeenNthCalledWith(3, ["dirty", "conflicts", "wrongBranch"]);

    act(() => result.current.clearFilters());
    expect(saveOverviewFilters).toHaveBeenLastCalledWith([]);
    expect(result.current.filters.size).toBe(0);
  });

  it("keeps local filtering active when persistence fails", async () => {
    saveOverviewFilters.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useOverviewFilters());
    await waitFor(() => expect(loadUiState).toHaveBeenCalledOnce());

    act(() => result.current.toggleFilter("ahead"));

    expect(result.current.filters.has("ahead")).toBe(true);
  });
});
