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
      repo: { treeWidth: null, inspectorWidth: null },
    });
    updateUiState.mockResolvedValue({
      version: 1,
      repo: { treeWidth: 276, inspectorWidth: 410 },
    });
    localStorage.setItem("fjord:repo-layout:v1", JSON.stringify({ left: 276, right: 410 }));
    const { loadUiState } = await import("@/infrastructure/uiState");

    const state = await loadUiState();

    expect(updateUiState).toHaveBeenCalledWith({
      repo: { treeWidth: 276, inspectorWidth: 410 },
    });
    expect(state.repo).toEqual({ treeWidth: 276, inspectorWidth: 410 });
    expect(localStorage.getItem("fjord:repo-layout:v1")).toBeNull();
  });

  it("keeps the legacy key when persistence fails so migration can retry", async () => {
    getUiState.mockResolvedValue({
      version: 1,
      repo: { treeWidth: null, inspectorWidth: null },
    });
    updateUiState.mockRejectedValue(new Error("database locked"));
    localStorage.setItem("fjord:repo-layout:v1", JSON.stringify({ left: 276, right: 410 }));
    const { loadUiState } = await import("@/infrastructure/uiState");

    await expect(loadUiState()).rejects.toThrow("database locked");
    expect(localStorage.getItem("fjord:repo-layout:v1")).not.toBeNull();
  });
});
