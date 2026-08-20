import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkingFileActions } from "@/application/useWorkingFileActions";
import {
  exportPatch,
  getPatchText,
  openRepositoryPath,
  previewIgnoreRule,
  resolveRepositoryFilePath,
  revealRepositoryPath,
} from "@/infrastructure/tauriClient";
import { pickSaveDestination } from "@/infrastructure/dialog";
import { buildWholeFilePatchSelection } from "@/application/wholeFilePatchSelection";

vi.mock("@/infrastructure/tauriClient", () => ({
  openRepositoryPath: vi.fn(async () => undefined),
  previewIgnoreRule: vi.fn(async () => ({ rule: "/src/app.ts", alreadyPresent: false })),
  resolveRepositoryFilePath: vi.fn(async () => ({
    relative: "src/app.ts",
    absolute: "C:\\repo\\src\\app.ts",
  })),
  revealRepositoryPath: vi.fn(async () => undefined),
  exportPatch: vi.fn(async () => undefined),
  getPatchText: vi.fn(async () => "--- a/src/app.ts\n+++ b/src/app.ts\n"),
}));

vi.mock("@/infrastructure/dialog", () => ({
  pickSaveDestination: vi.fn(async () => "C:\\Users\\me\\app.ts.patch"),
}));

const wholeFileSelection = {
  path: "src/app.ts",
  source: "worktree" as const,
  baseDigest: "digest",
  hunks: [],
};

vi.mock("@/application/wholeFilePatchSelection", () => ({
  buildWholeFilePatchSelection: vi.fn(async () => wholeFileSelection),
}));

describe("useWorkingFileActions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes row mutations through the same single-path callbacks", async () => {
    const onStage = vi.fn();
    const onUnstage = vi.fn();
    const options = dependencies({ onStage, onUnstage });
    const { result } = renderHook(() => useWorkingFileActions(options));

    await act(() => result.current.dispatch("stage", { path: "src/app.ts", source: "worktree" }));
    await act(() => result.current.dispatch("unstage", { path: "src/app.ts", source: "index" }));

    expect(onStage).toHaveBeenCalledWith(["src/app.ts"]);
    expect(onUnstage).toHaveBeenCalledWith(["src/app.ts"]);
  });

  it("routes delete through the onDelete callback with the exact target", async () => {
    const onDelete = vi.fn();
    const { result } = renderHook(() => useWorkingFileActions(dependencies({ onDelete })));
    const target = { path: "src/app.ts", source: "worktree" as const };

    await act(() => result.current.dispatch("delete", target));

    expect(onDelete).toHaveBeenCalledWith(target);
  });

  it("uses backend-resolved paths for launches, reveal, and absolute-path copy", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { result } = renderHook(() => useWorkingFileActions(dependencies()));
    const target = { path: "src/app.ts", source: "worktree" as const };

    await act(() => result.current.dispatch("openEditor", target));
    await act(() => result.current.dispatch("openDefault", target));
    await act(() => result.current.dispatch("reveal", target));
    await act(() => result.current.dispatch("copyRelative", target));
    await act(() => result.current.dispatch("copyAbsolute", target));

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

  it("previews the exact ignore rule before confirming the mutation", async () => {
    const onAddIgnore = vi.fn(async () => "added" as const);
    const { result } = renderHook(() => useWorkingFileActions(dependencies({ onAddIgnore })));
    const target = { path: "src/app.ts", source: "worktree" as const };

    await act(() => result.current.dispatch("ignoreExtension", target));

    expect(previewIgnoreRule).toHaveBeenCalledWith("repo-1", target.path, "extension");
    expect(result.current.ignoreRule?.preview?.rule).toBe("/src/app.ts");
    expect(onAddIgnore).not.toHaveBeenCalled();

    await act(() => result.current.confirmIgnoreRule());

    expect(onAddIgnore).toHaveBeenCalledWith(target, "extension");
    expect(result.current.ignoreRule?.outcome).toBe("added");
  });

  it("exports a patch to a picked destination and reports where it was saved", async () => {
    const onPatchSaved = vi.fn();
    const { result } = renderHook(() => useWorkingFileActions(dependencies({ onPatchSaved })));
    const target = { path: "src/app.ts", source: "worktree" as const };

    await act(() => result.current.dispatch("createPatch", target));

    expect(buildWholeFilePatchSelection).toHaveBeenCalledWith("repo-1", "src/app.ts", "worktree");
    expect(pickSaveDestination).toHaveBeenCalledWith("app.ts.patch");
    expect(exportPatch).toHaveBeenCalledWith("repo-1", wholeFileSelection, "C:\\Users\\me\\app.ts.patch");
    expect(onPatchSaved).toHaveBeenCalledWith("C:\\Users\\me\\app.ts.patch");
  });

  it("does not export when the save dialog is cancelled", async () => {
    vi.mocked(pickSaveDestination).mockResolvedValueOnce(null);
    const onPatchSaved = vi.fn();
    const { result } = renderHook(() => useWorkingFileActions(dependencies({ onPatchSaved })));

    await act(() => result.current.dispatch("createPatch", { path: "src/app.ts", source: "worktree" }));

    expect(exportPatch).not.toHaveBeenCalled();
    expect(onPatchSaved).not.toHaveBeenCalled();
  });

  it("copies the same patch bytes to the clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { result } = renderHook(() => useWorkingFileActions(dependencies()));

    await act(() => result.current.dispatch("copyPatch", { path: "src/app.ts", source: "index" }));

    expect(buildWholeFilePatchSelection).toHaveBeenCalledWith("repo-1", "src/app.ts", "index");
    expect(getPatchText).toHaveBeenCalledWith("repo-1", wholeFileSelection);
    expect(writeText).toHaveBeenCalledWith("--- a/src/app.ts\n+++ b/src/app.ts\n");
  });
});

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    repoId: "repo-1",
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onDiscard: vi.fn(),
    onDelete: vi.fn(),
    onOpenMergeTool: vi.fn(),
    onAddIgnore: vi.fn(async () => "added" as const),
    onPatchSaved: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  } as Parameters<typeof useWorkingFileActions>[0];
}
