import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkingFileActions } from "@/application/useWorkingFileActions";
import {
  openRepositoryPath,
  resolveRepositoryFilePath,
  revealRepositoryPath,
} from "@/infrastructure/tauriClient";

vi.mock("@/infrastructure/tauriClient", () => ({
  openRepositoryPath: vi.fn(async () => undefined),
  resolveRepositoryFilePath: vi.fn(async () => ({
    relative: "src/app.ts",
    absolute: "C:\\repo\\src\\app.ts",
  })),
  revealRepositoryPath: vi.fn(async () => undefined),
}));

describe("useWorkingFileActions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes row mutations through the same single-path callbacks", async () => {
    const onStage = vi.fn();
    const onUnstage = vi.fn();
    const options = dependencies({ onStage, onUnstage });
    const { result } = renderHook(() => useWorkingFileActions(options));

    await act(() => result.current("stage", { path: "src/app.ts", source: "worktree" }));
    await act(() => result.current("unstage", { path: "src/app.ts", source: "index" }));

    expect(onStage).toHaveBeenCalledWith(["src/app.ts"]);
    expect(onUnstage).toHaveBeenCalledWith(["src/app.ts"]);
  });

  it("uses backend-resolved paths for launches, reveal, and absolute-path copy", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { result } = renderHook(() => useWorkingFileActions(dependencies()));
    const target = { path: "src/app.ts", source: "worktree" as const };

    await act(() => result.current("openEditor", target));
    await act(() => result.current("openDefault", target));
    await act(() => result.current("reveal", target));
    await act(() => result.current("copyRelative", target));
    await act(() => result.current("copyAbsolute", target));

    expect(openRepositoryPath).toHaveBeenNthCalledWith(1, "repo-1", target.path, {
      kind: "configuredEditor",
      line: null,
    });
    expect(openRepositoryPath).toHaveBeenNthCalledWith(2, "repo-1", target.path, {
      kind: "defaultApplication",
    });
    expect(revealRepositoryPath).toHaveBeenCalledWith("repo-1", target.path);
    expect(resolveRepositoryFilePath).toHaveBeenCalledWith("repo-1", target.path);
    expect(writeText).toHaveBeenNthCalledWith(1, "src/app.ts");
    expect(writeText).toHaveBeenNthCalledWith(2, "C:\\repo\\src\\app.ts");
  });
});

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    repoId: "repo-1",
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onDiscard: vi.fn(),
    onOpenMergeTool: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  } as Parameters<typeof useWorkingFileActions>[0];
}
