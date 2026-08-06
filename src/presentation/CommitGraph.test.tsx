import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo, CommitSummary, TagInfo } from "@/domain/git";
import { CommitGraph } from "@/presentation/CommitGraph";

const graphState = vi.hoisted(() => ({
  branches: [] as BranchInfo[],
  commits: [] as CommitSummary[],
  hasMore: false,
  loadMore: vi.fn(),
  loadUntilCommit: vi.fn(),
  loadingUntilCommitId: null as string | null,
  scrollToIndex: vi.fn(),
  tags: [] as TagInfo[],
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 30,
        start: index * 30,
      })),
    scrollToIndex: graphState.scrollToIndex,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, values?: Record<string, number>) =>
      values && "count" in values ? `${key}:${values.count}` : key,
  }),
}));

vi.mock("@/application/useBranches", () => ({
  useBranches: () => ({ branches: graphState.branches, error: null, loading: false }),
}));

vi.mock("@/application/useCommitLog", () => ({
  useCommitLog: () => ({
    commits: graphState.commits,
    error: null,
    hasMore: graphState.hasMore,
    loadMore: graphState.loadMore,
    loadingUntilCommitId: graphState.loadingUntilCommitId,
    loadUntilCommit: graphState.loadUntilCommit,
    loading: false,
  }),
}));

vi.mock("@/application/useCommitSearch", () => ({
  useCommitSearch: () => ({ commits: [], error: null, loading: false }),
}));

vi.mock("@/application/useTags", () => ({
  useTags: () => ({ tags: graphState.tags, error: null, loading: false }),
}));

describe("CommitGraph", () => {
  beforeEach(() => {
    graphState.branches = [];
    graphState.commits = [];
    graphState.hasMore = false;
    graphState.loadMore.mockClear();
    graphState.loadUntilCommit.mockClear();
    graphState.loadingUntilCommitId = null;
    graphState.scrollToIndex.mockClear();
    graphState.tags = [];
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(cleanup);

  it("shows branch and tag badges from their target commits when log refs are empty", () => {
    graphState.commits = [
      {
        id: "commit-1",
        parentIds: [],
        message: "Feature tip",
        authorName: "Fjord",
        authorEmail: "fjord@example.com",
        authoredAt: "2026-08-06T10:00:00Z",
        refs: [],
      },
    ];
    graphState.branches = [
      {
        name: "develop",
        isCurrent: true,
        isRemote: false,
        upstream: null,
        targetCommitId: "commit-1",
      },
    ];
    graphState.tags = [{ name: "v1.0.0", targetCommitId: "commit-1" }];

    render(<CommitGraph repoId="repo-1" currentBranch="develop" />);

    expect(screen.getByText("develop")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });

  it("scrolls to the requested branch target commit", async () => {
    const onRevealCommit = vi.fn();
    graphState.commits = [
      commit("commit-1", "Main tip"),
      commit("commit-2", "Feature tip"),
    ];
    graphState.branches = [
      {
        name: "feature",
        isCurrent: false,
        isRemote: false,
        upstream: null,
        targetCommitId: "commit-2",
      },
    ];

    render(
      <CommitGraph
        repoId="repo-1"
        currentBranch="main"
        scrollToBranch={{ branch: "feature", id: 1 }}
        onRevealCommit={onRevealCommit}
      />,
    );

    await waitFor(() => {
      expect(graphState.scrollToIndex).toHaveBeenCalledWith(1, { align: "center", behavior: "smooth" });
    });
    expect(onRevealCommit).toHaveBeenCalledWith(graphState.commits[1]);
  });

  it("loads history until the requested branch target is rendered", async () => {
    graphState.commits = [commit("commit-1", "Main tip")];
    graphState.branches = [
      {
        name: "feature",
        isCurrent: false,
        isRemote: false,
        upstream: null,
        targetCommitId: "commit-99",
      },
    ];

    render(
      <CommitGraph
        repoId="repo-1"
        currentBranch="main"
        scrollToBranch={{ branch: "feature", id: 1 }}
      />,
    );

    await waitFor(() => {
      expect(graphState.loadUntilCommit).toHaveBeenCalledWith("commit-99");
    });
  });

  it("selects and scrolls through commits with the arrow keys", () => {
    const onSelectCommit = vi.fn();
    graphState.commits = [commit("commit-1", "First"), commit("commit-2", "Second")];

    render(
      <CommitGraph
        repoId="repo-1"
        currentBranch="main"
        selectedCommitId="commit-1"
        onSelectCommit={onSelectCommit}
      />,
    );

    const firstRow = screen.getByText("First").closest<HTMLElement>("[data-commit-id]");
    expect(firstRow).not.toBeNull();
    fireEvent.keyDown(firstRow!, { key: "ArrowDown" });

    expect(onSelectCommit).toHaveBeenCalledWith(graphState.commits[1]);
    expect(graphState.scrollToIndex).toHaveBeenCalledWith(1, { align: "auto" });
  });

  it("marks the selected commit first-parent path", () => {
    graphState.commits = [
      { ...commit("commit-3", "Selected"), parentIds: ["commit-2"] },
      commit("side-1", "Side branch"),
      { ...commit("commit-2", "Parent"), parentIds: ["commit-1"] },
      commit("commit-1", "Root"),
    ];

    render(
      <CommitGraph repoId="repo-1" selectedCommitId="commit-3" onSelectCommit={vi.fn()} />,
    );

    expect(screen.getByText("Selected").closest("[data-commit-id]")).toHaveAttribute(
      "data-path-highlighted",
      "true",
    );
    expect(screen.getByText("Parent").closest("[data-commit-id]")).toHaveAttribute(
      "data-path-highlighted",
      "true",
    );
    expect(screen.getByText("Side branch").closest("[data-commit-id]")).toHaveAttribute(
      "data-path-highlighted",
      "false",
    );
  });
});

function commit(id: string, message: string): CommitSummary {
  return {
    id,
    parentIds: [],
    message,
    authorName: "Fjord",
    authorEmail: "fjord@example.com",
    authoredAt: "2026-08-06T10:00:00Z",
    refs: [],
  };
}
