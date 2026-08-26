import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo, CommitSummary, StashEntry, TagInfo } from "@/domain/git";
import { CommitGraph } from "@/presentation/CommitGraph";

const graphState = vi.hoisted(() => ({
  branches: [] as BranchInfo[],
  commits: [] as CommitSummary[],
  hasMore: false,
  loadMore: vi.fn(),
  loadUntilCommit: vi.fn(),
  loadingUntilCommitId: null as string | null,
  scrollToIndex: vi.fn(),
  searchResults: [] as CommitSummary[],
  stashes: [] as StashEntry[],
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
    t: (key: string, values?: Record<string, unknown>) =>
      key === "context.mergeInto"
        ? `Merge ${values?.source} into ${values?.target}…`
        : key === "context.squashMergeInto"
          ? `Squash merge ${values?.source} into ${values?.target}…`
          : key === "stash.markerLabel"
            ? `Stash ${values?.title}, ${values?.ref}`
          : values && "count" in values ? `${key}:${values.count}` : key,
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
  useCommitSearch: (_repoId: string | null, query: string) => ({
    commits: query.trim().length > 0 ? graphState.searchResults : [],
    error: null,
    loading: false,
  }),
}));

vi.mock("@/application/useTags", () => ({
  useTags: () => ({ tags: graphState.tags, error: null, loading: false }),
}));

vi.mock("@/application/useStashes", () => ({
  useStashes: () => ({ stashes: graphState.stashes, error: null, loading: false }),
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
    graphState.searchResults = [];
    graphState.stashes = [];
    graphState.tags = [];
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

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
        ahead: 0,
        behind: 0,
        targetCommitId: "commit-1",
      },
    ];
    graphState.tags = [{ name: "v1.0.0", targetCommitId: "commit-1" }];

    render(<CommitGraph repoId="repo-1" currentBranch="develop" />);

    // Only the front-most ref (the active branch) shows inline; the rest
    // collapse behind a "+N" count instead of overflowing into the graph.
    expect(screen.getByText("develop")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.queryByText("v1.0.0")).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByText("+1").parentElement!);

    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });

  it("attaches a stash marker to entry.base rather than the stash commit id", () => {
    graphState.commits = [
      commit("commit-a", "Commit A"),
      commit("commit-b", "Commit B"),
      commit("commit-c", "Commit C"),
    ];
    graphState.stashes = [stash("stash-storage-commit", "commit-b", "Payment validation WIP")];

    const { container } = render(<CommitGraph repoId="repo-1" />);

    const marker = container.querySelector<HTMLElement>("[data-stash-id='stash-storage-commit']")!;
    expect(marker).toBeInTheDocument();
    expect(marker.closest<HTMLElement>("[data-commit-id]")?.dataset.commitId).toBe("commit-b");
    expect(container.querySelector("[data-commit-id='commit-a'] [data-stash-id]")).toBeNull();
    expect(container.querySelector("[data-commit-id='commit-c'] [data-stash-id]")).toBeNull();
    expect(container.querySelector("[data-commit-id='stash-storage-commit']")).toBeNull();
  });

  it("keeps same-base stash identities selectable through inline and overflow badges", () => {
    const onSelectStash = vi.fn();
    const onStashContextMenu = vi.fn();
    graphState.commits = [commit("commit-b", "Commit B")];
    graphState.stashes = [
      stash("stash-first", "commit-b", "Same title", 0),
      stash("stash-second", "commit-b", "Same title", 1),
    ];

    const { container } = render(
      <CommitGraph
        repoId="repo-1"
        onSelectStash={onSelectStash}
        onStashContextMenu={onStashContextMenu}
      />,
    );

    fireEvent.click(container.querySelector("[data-stash-id='stash-first']")!);
    expect(onSelectStash).toHaveBeenLastCalledWith("stash-first");

    fireEvent.mouseEnter(screen.getByText("+1").parentElement!);
    const second = container.querySelector<HTMLElement>("[data-stash-id='stash-second']")!;
    fireEvent.click(second);
    expect(onSelectStash).toHaveBeenLastCalledWith("stash-second");

    fireEvent.contextMenu(second, { clientX: 24, clientY: 36 });
    expect(onStashContextMenu).toHaveBeenLastCalledWith("stash-second");
    expect(onStashContextMenu).not.toHaveBeenCalledWith("stash-first");
  });

  it("does not render or seek an unloaded stash base until Reveal in graph is requested", async () => {
    const onRevealStashNotFound = vi.fn();
    graphState.commits = [commit("commit-a", "Commit A")];
    graphState.stashes = [stash("stash-hidden", "commit-missing", "Hidden stash")];
    graphState.loadUntilCommit.mockResolvedValue(false);

    const view = render(<CommitGraph repoId="repo-1" />);

    expect(view.container.querySelector("[data-stash-id='stash-hidden']")).toBeNull();
    expect(view.container.querySelector<HTMLElement>("[data-commit-id='commit-a']")?.style.height).toBe("30px");
    expect(graphState.loadUntilCommit).not.toHaveBeenCalled();

    view.rerender(
      <CommitGraph
        repoId="repo-1"
        revealStashRequest={{ id: 1, stashId: "stash-hidden", base: "commit-missing" }}
        onRevealStashNotFound={onRevealStashNotFound}
      />,
    );

    await waitFor(() => {
      expect(graphState.loadUntilCommit).toHaveBeenCalledWith("commit-missing");
      expect(onRevealStashNotFound).toHaveBeenCalledWith("stash-hidden");
    });
    expect(graphState.loadUntilCommit).not.toHaveBeenCalledWith("stash-hidden");
  });

  it("scrolls to a loaded revealed base and selects the same stable stash id", async () => {
    const onSelectStash = vi.fn();
    graphState.commits = [commit("commit-a", "Commit A"), commit("commit-b", "Commit B")];
    graphState.stashes = [stash("stash-revealed", "commit-b", "Reveal me")];

    render(
      <CommitGraph
        repoId="repo-1"
        onSelectStash={onSelectStash}
        revealStashRequest={{ id: 1, stashId: "stash-revealed", base: "commit-b" }}
      />,
    );

    await waitFor(() => {
      expect(graphState.scrollToIndex).toHaveBeenCalledWith(1, {
        align: "center",
        behavior: "smooth",
      });
      expect(onSelectStash).toHaveBeenCalledWith("stash-revealed");
    });
    expect(graphState.loadUntilCommit).not.toHaveBeenCalled();
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
        ahead: 0,
        behind: 0,
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
        ahead: 0,
        behind: 0,
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

  it("scrolls the full graph to a commit selected from search once the bar closes", () => {
    vi.useFakeTimers();
    const onSelectCommit = vi.fn();
    graphState.commits = [commit("commit-1", "First"), commit("commit-2", "Second")];
    graphState.searchResults = [commit("commit-2", "Second")];

    render(
      <CommitGraph
        repoId="repo-1"
        currentBranch="main"
        openSearchRequestId={1}
        onSelectCommit={onSelectCommit}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("commits.searchPlaceholder"), { target: { value: "second" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const resultRow = screen.getByText("Second").closest<HTMLElement>("[data-commit-id]");
    expect(resultRow).not.toBeNull();
    fireEvent.click(resultRow!);
    expect(onSelectCommit).toHaveBeenCalledWith(graphState.searchResults[0]);
    // Selecting from the filtered search list doesn't touch the main graph's
    // scroll yet — the target only exists in the (small) filtered list.
    expect(graphState.scrollToIndex).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("commits.closeSearch"));

    expect(graphState.scrollToIndex).toHaveBeenCalledWith(1, { align: "center", behavior: "smooth" });
  });

  it("pages the log forward to reveal a commit that search found beyond the loaded window", () => {
    vi.useFakeTimers();
    graphState.commits = [commit("commit-1", "First")];
    graphState.searchResults = [commit("commit-2", "Second")];

    render(<CommitGraph repoId="repo-1" currentBranch="main" openSearchRequestId={1} />);

    fireEvent.change(screen.getByPlaceholderText("commits.searchPlaceholder"), { target: { value: "second" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    fireEvent.click(screen.getByText("Second").closest<HTMLElement>("[data-commit-id]")!);
    fireEvent.click(screen.getByLabelText("commits.closeSearch"));

    expect(graphState.loadUntilCommit).toHaveBeenCalledWith("commit-2");
  });

  it("expands the ref flyout on hover, keeps it open while hovered, and stays interactive", () => {
    vi.useFakeTimers();
    const onCheckout = vi.fn();
    graphState.commits = [commit("commit-1", "Feature tip")];
    graphState.branches = [
      {
        name: "develop",
        isCurrent: true,
        isRemote: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        targetCommitId: "commit-1",
      },
      {
        name: "feature/x",
        isCurrent: false,
        isRemote: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        targetCommitId: "commit-1",
      },
    ];

    render(<CommitGraph repoId="repo-1" currentBranch="develop" onCheckout={onCheckout} />);

    expect(screen.queryByText("feature/x")).not.toBeInTheDocument();
    const trigger = screen.getByText("+1").parentElement!;
    fireEvent.mouseEnter(trigger);
    expect(screen.getByText("feature/x")).toBeInTheDocument();

    // Leaving the trigger for the flyout itself must not close it.
    fireEvent.mouseLeave(trigger);
    const flyout = screen.getByText("feature/x").closest('[role="menu"]') as HTMLElement;
    fireEvent.mouseEnter(flyout);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("feature/x")).toBeInTheDocument();

    // Refs inside the flyout remain checkoutable.
    fireEvent.doubleClick(screen.getByText("feature/x"));
    expect(onCheckout).toHaveBeenCalledWith("feature/x");

    fireEvent.mouseLeave(flyout);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("feature/x")).not.toBeInTheDocument();
  });

  it("merges the exact ref selected from a multi-ref commit", () => {
    const onMergeBranch = vi.fn();
    graphState.commits = [commit("commit-1", "Shared tip")];
    graphState.branches = [
      branch("develop", true),
      branch("feature/first", false),
      branch("feature/second", false),
    ];

    render(
      <CommitGraph
        repoId="repo-1"
        currentBranch="develop"
        onCheckout={vi.fn()}
        onMergeBranch={onMergeBranch}
      />,
    );

    fireEvent.mouseEnter(screen.getByText("+2").parentElement!);
    fireEvent.contextMenu(screen.getByText("feature/second"));
    fireEvent.click(screen.getByRole("menuitem", {
      name: "Merge feature/second into develop…",
    }));
    expect(onMergeBranch).toHaveBeenCalledWith({
      refName: "refs/heads/feature/second",
      kind: "localBranch",
    });
  });

  it("offers an enabled merge entry for a remote-tracking branch label", () => {
    const onMergeBranch = vi.fn();
    graphState.commits = [commit("commit-1", "Remote tip")];
    graphState.branches = [branch("develop", true), branch("origin/feature", false, true)];

    render(
      <CommitGraph
        repoId="repo-1"
        currentBranch="develop"
        onCheckout={vi.fn()}
        onMergeBranch={onMergeBranch}
      />,
    );

    fireEvent.mouseEnter(screen.getByText("+1").parentElement!);
    fireEvent.contextMenu(screen.getByText("feature"));
    const mergeItem = screen.getByRole("menuitem", {
      name: "Merge feature into develop…",
    });
    expect(mergeItem).toBeEnabled();
    fireEvent.click(mergeItem);
    expect(onMergeBranch).toHaveBeenCalledWith({
      refName: "refs/remotes/origin/feature",
      kind: "remoteTracking",
    });
  });

  it("offers a separate squash-merge entry dispatching onSquashMergeBranch, not onMergeBranch", () => {
    const onMergeBranch = vi.fn();
    const onSquashMergeBranch = vi.fn();
    graphState.commits = [commit("commit-1", "Shared tip")];
    graphState.branches = [branch("develop", true), branch("feature/x", false)];

    render(
      <CommitGraph
        repoId="repo-1"
        currentBranch="develop"
        onCheckout={vi.fn()}
        onMergeBranch={onMergeBranch}
        onSquashMergeBranch={onSquashMergeBranch}
      />,
    );

    fireEvent.mouseEnter(screen.getByText("+1").parentElement!);
    fireEvent.contextMenu(screen.getByText("feature/x"));
    expect(screen.getByRole("menuitem", { name: "Merge feature/x into develop…" })).toBeInTheDocument();
    const squashItem = screen.getByRole("menuitem", {
      name: "Squash merge feature/x into develop…",
    });
    fireEvent.click(squashItem);
    expect(onSquashMergeBranch).toHaveBeenCalledWith({
      refName: "refs/heads/feature/x",
      kind: "localBranch",
    });
    expect(onMergeBranch).not.toHaveBeenCalled();
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

function stash(
  id: string,
  base: string,
  title: string,
  index = 0,
): StashEntry {
  return {
    id,
    index,
    refName: `stash@{${index}}`,
    message: `On develop: ${title}`,
    title,
    base,
    branch: "develop",
    createdAt: "2026-08-24T10:00:00Z",
    filesChanged: 1,
    hasIndexState: false,
    hasUntracked: false,
  };
}

function branch(name: string, isCurrent: boolean, isRemote = false): BranchInfo {
  return {
    name,
    isCurrent,
    isRemote,
    upstream: null,
    ahead: 0,
    behind: 0,
    targetCommitId: "commit-1",
  };
}
