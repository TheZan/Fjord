import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    oldMode: number | null;
    newMode: number | null;
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
  highlightTokens: new Map(),
  wordChanges: new Map(),
  useFileDiff: vi.fn(),
}));

vi.mock("@/presentation/useDiffHighlight", () => ({
  useDiffHighlight: (_path: string, _lines: unknown[], wordDiff: boolean) => ({
    tokens: state.highlightTokens,
    wordChanges: wordDiff ? state.wordChanges : new Map(),
  }),
}));

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: state.loadUiState,
  saveRepoModes: state.saveRepoModes,
}));

vi.mock("@/infrastructure/tauriClient", () => ({
  preflightDestructiveAction: state.preflight,
}));

vi.mock("@/application/useFileDiff", () => ({
  useFileDiff: (...args: unknown[]) => {
    state.useFileDiff(...args);
    return {
    diff: state.diff,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    loadMore: state.loadMore,
    error: state.error,
    generations: state.generations,
    snapshotInvalid: state.snapshotInvalid,
    };
  },
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
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
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
    state.highlightTokens = new Map();
    state.wordChanges = new Map();
    state.useFileDiff.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("mirrors horizontal scroll between the split panes", async () => {
    state.hasMore = false;
    state.loadUiState.mockResolvedValue({ repo: { diffMode: "split" } });
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "working", staged: false }} />,
    );
    await waitFor(() => expect(screen.getByRole("radio", { name: "diff.split" })).toHaveAttribute("aria-checked", "true"));

    const oldPane = screen.getByTestId("split-scroll-old");
    const newPane = screen.getByTestId("split-scroll-new");

    // Scrolling the left pane mirrors into the right pane. A real browser
    // fires the mirrored 'scroll' event on newPane asynchronously once its
    // scrollLeft is set programmatically; fireEvent.scroll simulates that echo.
    oldPane.scrollLeft = 42;
    fireEvent.scroll(oldPane);
    expect(newPane.scrollLeft).toBe(42);
    fireEvent.scroll(newPane);
    expect(oldPane.scrollLeft).toBe(42);

    // Scrolling the right pane mirrors back into the left pane.
    newPane.scrollLeft = 90;
    fireEvent.scroll(newPane);
    expect(oldPane.scrollLeft).toBe(90);
    fireEvent.scroll(oldPane);
    expect(newPane.scrollLeft).toBe(90);
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

  it("upgrades a visible row with worker tokens without replacing its content", () => {
    state.hasMore = false;
    state.highlightTokens = new Map([["0:1", [{ start: 0, length: 3, kind: "keyword" }]]]);
    render(
      <FileDiffView repoId="repo-1" path="large.ts" source={{ kind: "commit", commitId: "deadbeef" }} />,
    );

    const token = document.querySelector('[data-syntax-token="keyword"]');
    expect(token).toHaveTextContent("new");
    expect(token?.parentElement).toHaveTextContent("+new line");
  });

  it("renders worker word ranges and keeps the patch selection identical when toggled off", async () => {
    state.hasMore = false;
    state.wordChanges = new Map([["0:0", [{ start: 0, length: 3 }]]]);
    const onApplyHunk = vi.fn().mockResolvedValue(true);
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={onApplyHunk}
      />,
    );

    expect(document.querySelector('[data-word-change="true"]')).toHaveTextContent("old");
    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "diff.stageSelectedLines" }));
    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("switch", { name: "diff.wordDiff" }));
    expect(document.querySelector('[data-word-change="true"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "diff.select.deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "diff.stageSelectedLines" }));
    await waitFor(() => expect(onApplyHunk).toHaveBeenCalledTimes(2));

    expect(onApplyHunk.mock.calls[1]).toEqual(onApplyHunk.mock.calls[0]);
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

  it("disables hunk and line actions with a reason when whitespace is ignored", () => {
    state.hasMore = false;
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyHunk={vi.fn()}
        onDiscardPatch={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "diff.whitespace.label" }), {
      target: { value: "ignoreAll" },
    });

    expect(screen.getByRole("button", { name: "diff.stageHunk" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "diff.stageHunk" })).toHaveAttribute(
      "title",
      "diff.whitespace.partialActionsDisabled",
    );
    expect(screen.queryByRole("button", { name: "diff.select.deletion" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "diff.discardHunk" })).toBeDisabled();
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
      [{
        path: "large.txt",
        source: "worktree",
        baseDigest: "digest-1",
        hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [] }],
      }],
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
      [{
        path: "large.txt",
        source: "worktree",
        baseDigest: "digest-1",
        hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [] }],
      }],
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

  it("shows authoritative totals and progressively loaded line counts", () => {
    state.hasMore = true;
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "commit", commitId: "deadbeef" }} />,
    );

    expect(screen.getByText("diff.counts")).toBeInTheDocument();
    expect(screen.getByText("diff.loaded")).toBeInTheDocument();
  });

  it("keeps stash diffs read-only while reusing the normal diff renderer", () => {
    state.hasMore = false;
    render(
      <FileDiffView
        repoId="repo-1"
        path="both.txt"
        source={{ kind: "stash", stashId: "stash-oid", group: "index" }}
      />,
    );

    expect(state.useFileDiff).toHaveBeenCalledWith(
      "repo-1",
      "both.txt",
      { kind: "stash", stashId: "stash-oid", group: "index" },
      "show",
      false,
    );
    expect(screen.getByText("@@ -4,2 +4,2 @@")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "diff.stageFile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "diff.unstageFile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "diff.discardFile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "diff.stageHunk" })).not.toBeInTheDocument();
  });

  it("requires an explicit load-anyway action above the display ceiling", () => {
    state.hasMore = false;
    state.diff = { ...textDiff(), tooLarge: true, fileBytes: 12 * 1024 * 1024, hunks: [] };
    render(
      <FileDiffView repoId="repo-1" path="large.txt" source={{ kind: "commit", commitId: "deadbeef" }} />,
    );

    expect(screen.getByText("too large: 12.0 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "diff.loadAnyway" }));
    expect(state.useFileDiff).toHaveBeenLastCalledWith(
      "repo-1",
      "large.txt",
      { kind: "commit", commitId: "deadbeef" },
      "show",
      true,
    );
  });

  it.each([
    ["binary", { isBinary: true }, "diff.binary"],
    ["mode-only", { hunks: [], totalHunks: 0, totalLines: 0, oldMode: 0o100644, newMode: 0o100755 }, "diff.modeOnly"],
  ])("keeps the whole-file action for the %s state", (_name, overrides, message) => {
    state.hasMore = false;
    state.diff = { ...textDiff(), ...overrides };
    const onApplyFile = vi.fn();
    render(
      <FileDiffView
        repoId="repo-1"
        path="large.txt"
        source={{ kind: "working", staged: false }}
        onApplyFile={onApplyFile}
      />,
    );

    expect(screen.getByText(message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "diff.stageFile" }));
    expect(onApplyFile).toHaveBeenCalledOnce();
  });

  it("measures the giant-file metadata viewport with React in the loop", () => {
    state.hasMore = false;
    state.diff = {
      ...textDiff(),
      tooLarge: true,
      fileBytes: 50 * 1024 * 1024,
      hunks: [],
      totalHunks: 42_000,
      totalLines: 500_000,
    };
    const samples: number[] = [];

    for (let iteration = 0; iteration < 23; iteration += 1) {
      const started = performance.now();
      const view = render(
        <FileDiffView repoId="repo-1" path="huge/long.txt" source={{ kind: "commit", commitId: "deadbeef" }} />,
      );
      const elapsed = performance.now() - started;
      view.unmount();
      if (iteration >= 3) samples.push(elapsed);
    }

    samples.sort((left, right) => left - right);
    const p50 = samples[Math.ceil(samples.length * 0.50) - 1];
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    const max = samples.at(-1)!;
    console.info(`p8-15-ui-ms p50=${p50.toFixed(3)} p95=${p95.toFixed(3)} max=${max.toFixed(3)}`);
    expect(p95).toBeLessThan(600);
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
    oldMode: 0o100644,
    newMode: 0o100644,
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
