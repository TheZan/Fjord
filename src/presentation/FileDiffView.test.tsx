import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileDiffView } from "@/presentation/FileDiffView";

const state = vi.hoisted(() => ({
  hasMore: true,
  loadMore: vi.fn(),
  loading: false,
  loadingMore: false,
  error: null as string | null,
  generations: { workingTree: 4, refs: 2, history: 1, stash: 0, config: 0 },
  diff: null as null | {
    path: string;
    changeType: "modified";
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
    truncated: boolean;
    nextOffset: number | null;
    baseDigest: string | null;
  },
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
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 20,
        start: index * 20,
      })),
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
    state.diff = textDiff();
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
        { kind: "deletion" as const, oldLineno: 4, newLineno: null, content: "old line" },
        { kind: "addition" as const, oldLineno: null, newLineno: 4, content: "new line" },
      ],
    }],
    totalHunks: 1,
    totalLines: 2_000,
    truncated: state.hasMore,
    nextOffset: state.hasMore ? 1_000 : null,
    baseDigest: "digest-1",
  };
}
