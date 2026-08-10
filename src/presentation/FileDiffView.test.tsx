import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileDiffView } from "@/presentation/FileDiffView";

const state = vi.hoisted(() => ({
  hasMore: true,
  loadMore: vi.fn(),
}));

vi.mock("@/application/useFileDiff", () => ({
  useFileDiff: () => ({
    diff: {
      path: "large.txt",
      changeType: "modified",
      isBinary: false,
      tooLarge: false,
      fileBytes: 100,
      hunks: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ kind: "context", oldLineno: 1, newLineno: 1, content: "line" }],
      }],
      totalHunks: 1,
      totalLines: 2_000,
      truncated: state.hasMore,
      nextOffset: state.hasMore ? 1_000 : null,
    },
    loading: false,
    loadingMore: false,
    hasMore: state.hasMore,
    loadMore: state.loadMore,
    error: null,
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
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("FileDiffView windowing", () => {
  beforeEach(() => {
    state.hasMore = true;
    state.loadMore.mockClear();
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
});
