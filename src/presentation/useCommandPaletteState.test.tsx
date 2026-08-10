import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalSearch } from "@/infrastructure/tauriClient";
import { useCommandPaletteState } from "@/presentation/useCommandPaletteState";
import type { GlobalSearchResult } from "@/domain/git";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/infrastructure/tauriClient", () => ({
  globalSearch: vi.fn(),
}));

const commitResult: GlobalSearchResult = {
  kind: "commit",
  repoId: "repo-1",
  workspaceId: "workspace-1",
  repoName: "Fjord",
  repoPath: "/dev/fjord",
  branch: "main",
  commit: {
    id: "abcdef012345",
    parentIds: [],
    message: "Close coverage gaps\n\nDetails",
    authorName: "Test",
    authorEmail: "test@example.com",
    authoredAt: "2026-08-10T00:00:00Z",
    refs: [],
  },
};

describe("useCommandPaletteState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(globalSearch).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens explicitly and clears the previous query", () => {
    const { result } = renderHook(() => useCommandPaletteState({ onSearchResult: vi.fn() }));
    act(() => result.current.setQuery("old query"));
    act(() => result.current.openPalette());

    expect(result.current.open).toBe(true);
    expect(result.current.query).toBe("");
  });

  it("debounces remote search, maps only commits, and dispatches the original result", async () => {
    const repositoryResult: GlobalSearchResult = { ...commitResult, kind: "repository", commit: null };
    vi.mocked(globalSearch).mockResolvedValue([repositoryResult, commitResult]);
    const onSearchResult = vi.fn();
    const { result } = renderHook(() => useCommandPaletteState({ onSearchResult }));

    act(() => {
      result.current.openPalette();
      result.current.setQuery("  gap  ");
    });
    await act(async () => vi.advanceTimersByTimeAsync(199));
    expect(globalSearch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });

    expect(globalSearch).toHaveBeenCalledWith("gap", null, 20);
    expect(result.current.remoteItems).toHaveLength(1);
    expect(result.current.remoteItems[0]).toMatchObject({
      id: "search:repo-1:abcdef012345",
      label: "Close coverage gaps",
      detail: "Fjord · abcdef0",
      kind: "commandPalette.commit",
    });
    act(() => void result.current.remoteItems[0].run());
    expect(onSearchResult).toHaveBeenCalledWith(commitResult);
  });

  it("does not search short queries and discards a request invalidated by closing", async () => {
    let resolveSearch!: (results: GlobalSearchResult[]) => void;
    vi.mocked(globalSearch).mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const { result } = renderHook(() => useCommandPaletteState({ onSearchResult: vi.fn() }));

    act(() => {
      result.current.openPalette();
      result.current.setQuery("x");
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(globalSearch).not.toHaveBeenCalled();

    act(() => result.current.setQuery("xy"));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(globalSearch).toHaveBeenCalledOnce();
    act(() => result.current.closePalette());
    await act(async () => resolveSearch([commitResult]));
    expect(result.current.remoteItems).toEqual([]);
  });
});
