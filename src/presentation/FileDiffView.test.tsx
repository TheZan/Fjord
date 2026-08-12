import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiffRows, FileDiffView } from "@/presentation/FileDiffView";
import type { GenerationSet } from "@/domain/git";

const state = vi.hoisted(() => ({
  hasMore: true,
  loadMore: vi.fn(),
  loading: false,
  loadingMore: false,
  error: null as string | null,
  snapshotInvalid: false,
  generations: { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 } as GenerationSet | null,
  diff: null as null | {
    path: string;
    changeType: "modified" | "deleted";
    isBinary: boolean;
    tooLarge: boolean;
    fileBytes: number;
    hunks: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: Array<{
        kind: "context" | "addition" | "deletion";
        oldLineno: number | null;
        newLineno: number | null;
        content: string;
      }>;
    }>;
    totalHunks: number;
    totalLines: number;
    offset: number;
    truncated: boolean;
    nextOffset: number | null;
    baseDigest: string | null;
  },
  preflight: vi.fn(),
  loadUiState: vi.fn(),
  saveRepoModes: vi.fn(),
  firstVisibleIndex: 0,
  measure: vi.fn(),
  scrollToIndex: vi.fn(),
}));

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: state.loadUiState,
  saveRepoModes: state.saveRepoModes,
}));

vi.mock("@/infrastructure/tauriClient", () => ({
  preflightDestructiveAction: state.preflight,
}));

vi.mock("@/application/useFileDiff", () => ({
  useFileDiff: () => ({
    diff: state.diff,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    loadMore: state.loadMore,
    error: state.error,
    generations: state.generations,
    snapshotInvalid: state.snapshotInvalid,
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: Math.max(0, count - state.firstVisibleIndex) }, (_, offset) => {
        const index = state.firstVisibleIndex + offset;
        return {
          index,
          key: index,
          size: 20,
          start: index * 20,
        };
      }),
    measure: state.measure,
    scrollToIndex: state.scrollToIndex,
  }),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key === "diff.tooLarge" ? `too large: ${values?.size}` : key,
  }),
}));

describe("FileDiffView windowing", () => {
  beforeEach(() => {
    state.hasMore = true;
    state.loadMore.mockClear();
    state.loading = false;
    state.loadingMore = false;
    state.error = null;
    state.snapshotInvalid = false;
    state.generations = { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 };
    state.diff = textDiff();
    state.preflight.mockReset();
    state.preflight.mockImplementation(async (_repoId, action) => ({
      action,
      consequences: [{ kind: "modifiedLinesDiscarded", path: "large.txt", count: 2 }],
      recoverable: "notRecoverable",
      blockers: [],
      generations: state.generations,
      confirmationToken: "confirmation-token",
    }));
    state.loadUiState.mockReset();
    state.loadUiState.mockResolvedValue({ repo: { diffMode: "unified" } });
    state.saveRepoModes.mockReset();
    state.saveRepoModes.mockResolvedValue(undefined);
    state.firstVisibleIndex = 0;
    state.measure.mockReset();
    state.scrollToIndex.mockReset();
  });

  it("builds unified rows and pairs changed lines in split rows", () => {
    const hunks = textDiff().hunks;

    expect(buildDiffRows(hunks, "unified").map((row) => row.kind)).toEqual(["hunk", "line", "line"]);
    const splitRows = buildDiffRows(hunks, "split");
    expect(splitRows.map((row) => row.kind)).toEqual(["hunk", "split"]);
    expect(splitRows[1]).toMatchObject({
      left: { lineIndex: 0, line: { kind: "deletion", content: "old line" } },
      right: { lineIndex: 1, line: { kind: "addition", content: "new line" } },
    });

    const paddedRows = buildDiffRows([{
      ...hunks[0],
      lines: [hunks[0].lines[0], { ...hunks[0].lines[0], oldLineno: 5 }, hunks[0].lines[1]],
    }], "split");
    expect(paddedRows[2]).toMatchObject({ left: { line: { oldLineno: 5 } }, right: null });
  });

  it("persists the header mode and keeps the first visible diff line anchored", async () => {
    state.hasMore = false;
    state.firstVisibleIndex = 2;
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "diff.split" }));

    expect(state.saveRepoModes).toHaveBeenCalledWith("split", null);
    expect(state.measure).toHaveBeenCalled();
    expect(state.scrollToIndex).toHaveBeenCalledWith(1, { align: "start" });
    expect(screen.getByRole("radio", { name: "diff.split" })).toHaveAttribute("aria-checked", "true");
  });

  it("restores the persisted diff mode", async () => {
    state.hasMore = false;
    state.loadUiState.mockResolvedValue({ repo: { diffMode: "split" } });
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "commit", commitId: "deadbeef" }} />,
    );

    await waitFor(() => expect(screen.getByRole("radio", { name: "diff.split" })).toHaveAttribute("aria-checked", "true"));
    expect(state.saveRepoModes).not.toHaveBeenCalled();
  });

  it("loads the next window near the virtualized end and stops when complete", async () => {
    const view = render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "commit", commitId: "deadbeef" }}
      />,
    );
    await waitFor(() => expect(state.loadMore).toHaveBeenCalledOnce());

    state.hasMore = false;
    view.rerender(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "commit", commitId: "deadbeef" }}
      />,
    );
    await Promise.resolve();
    expect(state.loadMore).toHaveBeenCalledOnce();
  });

  it("renders hunk coordinates and line prefixes through the virtualized row model", () => {
    state.hasMore = false;
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} />,
    );

    expect(screen.getByText("@@ -4,2 +4,2 @@")).toBeInTheDocument();
    expect(screen.getByText("-old line")).toBeInTheDocument();
    expect(screen.getByText("+new line")).toBeInTheDocument();
    expect(screen.getAllByText("4")).toHaveLength(2);
  });

  it("selects eligible changed lines while context lines remain non-interactive", () => {
    state.hasMore = false;
    state.diff = {
      ...textDiff(),
      hunks: [{
        ...textDiff().hunks[0],
        lines: [
          textDiff().hunks[0].lines[0],
          { kind: "context", oldLineno: 5, newLineno: 5, content: "unchanged" },
          textDiff().hunks[0].lines[1],
        ],
      }],
    };
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} onApplyHunk={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "diff.select.deletion" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "diff.select.addition" })).toBeEnabled();
    expect(screen.getByText("unchanged").closest("button")).toBeNull();
  });

  it("selects and deselects a changed line and updates the selected-lines action", () => {
    state.hasMore = false;
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} onApplyHunk={vi.fn()} />,
    );

    const action = screen.getByRole("button", { name: "diff.stageSelectedLines" });
    expect(action).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    expect(action).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "diff.deselect.deletion" }));
    expect(action).toBeDisabled();
  });

  it("stages only selected line indices with the backend digest and generations", async () => {
    state.hasMore = false;
    const onApplyHunk = vi.fn().mockResolvedValue(true);
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} onApplyHunk={onApplyHunk} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "diff.select.addition" }));
    fireEvent.click(screen.getByRole("button", { name: "diff.stageSelectedLines" }));

    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledWith({
      path: "large.txt",
      source: "worktree",
      baseDigest: "digest-1",
      hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [1] }],
    }, state.generations));
    expect(screen.getByRole("button", { name: "diff.stageSelectedLines" })).toBeDisabled();
  });

  it("unstages multiple selected lines using shift-click and the index source", async () => {
    state.hasMore = false;
    const original = textDiff();
    state.diff = {
      ...original,
      hunks: [{
        ...original.hunks[0],
        lines: [
          original.hunks[0].lines[0],
          { kind: "context", oldLineno: 5, newLineno: 5, content: "unchanged" },
          original.hunks[0].lines[1],
        ],
      }],
    };
    const onApplyHunk = vi.fn().mockResolvedValue(true);
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: true }} onApplyHunk={onApplyHunk} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "diff.select.addition" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "diff.unstageSelectedLines" }));

    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledWith(expect.objectContaining({
      source: "index",
      hunks: [expect.objectContaining({ lines: [0, 2] })],
    }), state.generations));
  });

  it("extends line selection with Shift+Arrow and clears it after a failed or stale mutation", async () => {
    state.hasMore = false;
    const onApplyHunk = vi.fn().mockResolvedValue(false);
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} onApplyHunk={onApplyHunk} />,
    );

    const deletion = screen.getByRole("button", { name: "diff.select.deletion" });
    deletion.focus();
    fireEvent.keyDown(deletion, { key: "ArrowDown", shiftKey: true });
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "diff.stageSelectedLines" }));

    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0));
  });

  it("prevents duplicate selected-line submission while pending", async () => {
    state.hasMore = false;
    let resolve!: (value: boolean) => void;
    const onApplyHunk = vi.fn().mockReturnValue(new Promise<boolean>((done) => { resolve = done; }));
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} onApplyHunk={onApplyHunk} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    const action = screen.getByRole("button", { name: "diff.stageSelectedLines" });
    fireEvent.click(action);
    fireEvent.click(action);
    expect(onApplyHunk).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "diff.stageSelectedLines" })).toBeDisabled();
    resolve(true);
    await waitFor(() => expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0));
  });

  it("does not carry line selection into a refreshed diff snapshot", async () => {
    state.hasMore = false;
    const view = render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} onApplyHunk={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);

    state.diff = { ...textDiff(), baseDigest: "digest-2" };
    state.generations = { ...state.generations!, workingTree: 5 };
    view.rerender(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} onApplyHunk={vi.fn()} />,
    );

    await waitFor(() => expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0));
  });

  it("clears line selection and every action when window validation invalidates the diff", async () => {
    state.hasMore = false;
    const view = render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={vi.fn()}
        onDiscardPatch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);

    state.diff = null;
    state.generations = null;
    state.loading = true;
    view.rerender(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={vi.fn()}
        onDiscardPatch={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0));
    expect(screen.queryByRole("button", { name: "diff.stageHunk" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "diff.discardFile" })).not.toBeInTheDocument();
  });

  it("immediately hides an open discard preflight when window validation invalidates the snapshot", async () => {
    state.hasMore = false;
    const view = render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onDiscardPatch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "diff.discardHunk" }));
    await screen.findByRole("dialog", { name: "preflight.discard.title" });

    state.diff = null;
    state.generations = null;
    state.loading = true;
    view.rerender(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onDiscardPatch={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("makes a rejected snapshot non-actionable until its refresh completes", async () => {
    state.hasMore = false;
    const onApplyHunk = vi.fn().mockResolvedValue(true);
    const onDiscardPatch = vi.fn();
    const view = render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={onApplyHunk}
        onDiscardPatch={onDiscardPatch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "diff.discardHunk" }));
    await screen.findByRole("dialog", { name: "preflight.discard.title" });

    state.snapshotInvalid = true;
    view.rerender(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={onApplyHunk}
        onDiscardPatch={onDiscardPatch}
      />,
    );

    await waitFor(() => expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "diff.stageHunk" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "diff.discardFile" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "diff.stageHunk" }));
    expect(onApplyHunk).not.toHaveBeenCalled();
    expect(onDiscardPatch).not.toHaveBeenCalled();

    view.unmount();
    const reopened = render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={onApplyHunk}
        onDiscardPatch={onDiscardPatch}
      />,
    );
    expect(screen.getByRole("button", { name: "diff.stageHunk" })).toBeDisabled();
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);

    state.diff = { ...textDiff(), baseDigest: "digest-b" };
    state.generations = { ...state.generations!, workingTree: 5 };
    state.snapshotInvalid = false;
    reopened.rerender(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={onApplyHunk}
        onDiscardPatch={onDiscardPatch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "diff.stageHunk" }));
    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledWith(
      expect.objectContaining({ baseDigest: "digest-b", source: "worktree" }),
      expect.objectContaining({ workingTree: 5 }),
    ));
  });

  it("stages exactly the selected unstaged hunk using the backend digest and generations", async () => {
    state.hasMore = false;
    const onApplyHunk = vi.fn().mockResolvedValue(true);
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={onApplyHunk}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "diff.stageHunk" }));
    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledWith({
      path: "large.txt",
      source: "worktree",
      baseDigest: "digest-1",
      hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [] }],
    }, state.generations));
  });

  it("unstages a staged hunk and prevents duplicate clicks while pending", async () => {
    state.hasMore = false;
    let resolve!: (value: boolean) => void;
    const onApplyHunk = vi.fn().mockReturnValue(new Promise<boolean>((done) => { resolve = done; }));
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: true }}
        onApplyHunk={onApplyHunk}
      />,
    );

    const button = screen.getByRole("button", { name: "diff.unstageHunk" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onApplyHunk).toHaveBeenCalledOnce();
    resolve(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "diff.unstageHunk" })).toBeEnabled());
    expect(onApplyHunk.mock.calls[0][0].source).toBe("index");
  });

  it("disables partial unstage controls for deleted files", () => {
    state.hasMore = false;
    state.diff = { ...textDiff(), changeType: "deleted" as const };
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: true }}
        onApplyHunk={vi.fn()}
      />,
    );

    const hunk = screen.getByRole("button", { name: "diff.unstageHunk" });
    expect(hunk).toBeDisabled();
    expect(hunk).toHaveAttribute("title", "diff.partialDeletedUnstageUnsupported");
    expect(screen.getByRole("button", { name: "diff.unstageSelectedLines" })).toBeDisabled();
  });

  it("routes hunk discard through preflight and cancel performs no mutation", async () => {
    state.hasMore = false;
    const onDiscardPatch = vi.fn();
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={vi.fn()}
        onDiscardPatch={onDiscardPatch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "diff.discardHunk" }));
    await waitFor(() => expect(state.preflight).toHaveBeenCalledWith(
      "repo-1",
      {
        kind: "discard",
        selection: {
          kind: "hunk",
          path: "large.txt",
          oldStart: 4,
          oldLines: 2,
          newStart: 4,
          newLines: 2,
        },
      },
      {
        path: "large.txt",
        source: "worktree",
        baseDigest: "digest-1",
        hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [] }],
      },
    ));
    expect(onDiscardPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "context.cancel" }));
    expect(onDiscardPatch).not.toHaveBeenCalled();
  });

  it("confirms selected-line discard with the exact frozen patch and generation", async () => {
    state.hasMore = false;
    const onDiscardPatch = vi.fn().mockResolvedValue(true);
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={vi.fn()}
        onDiscardPatch={onDiscardPatch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "diff.select.addition" }));
    fireEvent.click(screen.getByRole("button", { name: "diff.discardSelectedLines" }));
    await screen.findByRole("dialog", { name: "preflight.discard.title" });
    expect(onDiscardPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "preflight.discard.confirm" }));

    await waitFor(() => expect(onDiscardPatch).toHaveBeenCalledWith(
      {
        kind: "discard",
        selection: {
          kind: "lines",
          path: "large.txt",
          oldStart: 4,
          oldLines: 2,
          newStart: 4,
          newLines: 2,
          lines: [1],
        },
      },
      {
        path: "large.txt",
        source: "worktree",
        baseDigest: "digest-1",
        hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [1] }],
      },
      state.generations,
      "confirmation-token",
    ));
    expect(state.preflight).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
  });

  it("routes whole-file discard through one file preflight and hides discard for staged diffs", async () => {
    state.hasMore = false;
    const onDiscardPatch = vi.fn();
    const view = render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onDiscardPatch={onDiscardPatch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "diff.discardFile" }));
    await waitFor(() => expect(state.preflight).toHaveBeenCalledWith(
      "repo-1",
      {
        kind: "discard",
        selection: { kind: "file", path: "large.txt" },
      },
      {
        path: "large.txt",
        source: "worktree",
        baseDigest: "digest-1",
        hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [] }],
      },
    ));
    expect(onDiscardPatch).not.toHaveBeenCalled();

    view.rerender(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: true }}
        onDiscardPatch={onDiscardPatch}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "diff.discardFile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "diff.discardHunk" })).not.toBeInTheDocument();
  });

  it("does not allow whole-file discard until every diff window is loaded", () => {
    state.hasMore = true;
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onDiscardPatch={vi.fn()}
      />,
    );

    const action = screen.getByRole("button", { name: "diff.discardFile" });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute("title", "diff.discardFileIncomplete");
  });

  it("prevents duplicate confirmation and freezes line selection while discard is pending", async () => {
    state.hasMore = false;
    let resolve!: (value: boolean) => void;
    const onDiscardPatch = vi.fn().mockReturnValue(new Promise<boolean>((done) => { resolve = done; }));
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onDiscardPatch={onDiscardPatch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "diff.discardSelectedLines" }));
    const confirm = await screen.findByRole("button", { name: "preflight.discard.confirm" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(onDiscardPatch).toHaveBeenCalledOnce());
    expect(confirm).toBeDisabled();
    resolve(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([
    [{ isBinary: true }, "diff.binary"],
    [{ tooLarge: true, fileBytes: 2 * 1024 * 1024 }, "too large: 2.0 MB"],
    [{ hunks: [], totalHunks: 0, totalLines: 0 }, "diff.empty"],
  ])("renders a non-text state without diff rows", (overrides, message) => {
    state.hasMore = false;
    state.diff = { ...textDiff(), ...overrides };
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "commit", commitId: "deadbeef" }} />,
    );

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText("@@ -4,2 +4,2 @@")).not.toBeInTheDocument();
  });

  it("reports errors and dispatches the optional back action", () => {
    state.hasMore = false;
    state.diff = null;
    state.error = "diff failed";
    const onBack = vi.fn();
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: true }} onBack={onBack} />,
    );

    expect(screen.getByText("diff failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /diff.back/ }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

function textDiff() {
  return {
    path: "large.txt",
    changeType: "modified" as const,
    isBinary: false,
    tooLarge: false,
    fileBytes: 100,
    hunks: [{
      oldStart: 4,
      oldLines: 2,
      newStart: 4,
      newLines: 2,
      lines: [
        { kind: "deletion" as const, oldLineno: 4, newLineno: null, content: "old line", lineEnding: null },
        { kind: "addition" as const, oldLineno: null, newLineno: 4, content: "new line", lineEnding: null },
      ],
    }],
    totalHunks: 1,
    totalLines: 2_000,
    offset: 0,
    truncated: state.hasMore,
    nextOffset: state.hasMore ? 1_000 : null,
    baseDigest: "digest-1",
  };
}
