import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStashFiles } from "@/application/useStashFiles";
import type { StashEntry } from "@/domain/git";
import { StashInspector } from "@/presentation/StashInspector";

vi.mock("@/application/useStashFiles", () => ({ useStashFiles: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    scrollToIndex: vi.fn(),
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      size: 29,
      start: index * 29,
    })),
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "stash.inspector.createdFrom") return `Created from ${values?.branch}`;
      if (key === "stash.inspector.files") return `${values?.count} files`;
      return key;
    },
  }),
}));

const stash: StashEntry = {
  id: "stash-oid",
  index: 2,
  refName: "stash@{2}",
  message: "On develop: Payment validation WIP",
  title: "Payment validation WIP",
  base: "a84c1201234567890abcdef1234567890abcdef",
  branch: "develop",
  createdAt: "2026-08-12T11:05:00Z",
  filesChanged: 3,
  hasIndexState: true,
  hasUntracked: true,
};

describe("StashInspector", () => {
  beforeEach(() => {
    vi.mocked(useStashFiles).mockReturnValue({
      files: {
        staged: [{ path: "both.txt", changeType: "modified", additions: 1, deletions: 0 }],
        worktree: [{ path: "both.txt", changeType: "modified", additions: 1, deletions: 0 }],
        untracked: [{ path: "notes.txt", changeType: "added", additions: 2, deletions: 0 }],
        truncated: false,
      },
      loading: false,
      error: null,
    });
  });

  it("renders stash metadata and all non-empty recorded groups", () => {
    render(<StashInspector repoId="repo-1" stash={stash} selectedFile={null} onSelectFile={vi.fn()} onStashAction={vi.fn()} />);

    expect(screen.getByText("Payment validation WIP")).toBeInTheDocument();
    expect(screen.getByText("stash@{2}")).toBeInTheDocument();
    expect(screen.getByText("Created from develop")).toBeInTheDocument();
    expect(screen.getByTitle(stash.base)).toHaveTextContent("a84c120");
    expect(screen.getByText("3 files")).toBeInTheDocument();
    expect(screen.getByText("stash.inspector.applyIsUnstaged")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "stash.inspector.groupStaged" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "stash.inspector.groupWorktree" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "stash.inspector.groupUntracked" })).toBeInTheDocument();
  });

  it("exposes Reveal in graph from the inspector", () => {
    const onStashAction = vi.fn();
    render(
      <StashInspector
        repoId="repo-1"
        stash={stash}
        selectedFile={null}
        onSelectFile={vi.fn()}
        canRevealInGraph
        onStashAction={onStashAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "stash.action.more" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "stash.action.revealInGraph" }));
    expect(onStashAction).toHaveBeenCalledWith("revealInGraph", stash);
  });

  it("routes promoted Apply and Pop actions through the same stash dispatcher", () => {
    const onStashAction = vi.fn();
    render(
      <StashInspector
        repoId="repo-1"
        stash={stash}
        selectedFile={null}
        onSelectFile={vi.fn()}
        onStashAction={onStashAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "stash.action.apply" }));
    fireEvent.click(screen.getByRole("button", { name: "stash.action.pop" }));
    expect(onStashAction).toHaveBeenNthCalledWith(1, "apply", stash);
    expect(onStashAction).toHaveBeenNthCalledWith(2, "pop", stash);
  });

  it("keys duplicate paths by group when selecting their distinct rows", () => {
    const onSelectFile = vi.fn();
    render(<StashInspector repoId="repo-1" stash={stash} selectedFile={null} onSelectFile={onSelectFile} onStashAction={vi.fn()} />);
    const duplicateRows = screen.getAllByTitle("both.txt");

    fireEvent.click(duplicateRows[0]);
    fireEvent.click(duplicateRows[1]);

    expect(onSelectFile).toHaveBeenNthCalledWith(1, { stashId: stash.id, group: "index", path: "both.txt" });
    expect(onSelectFile).toHaveBeenNthCalledWith(2, { stashId: stash.id, group: "worktree", path: "both.txt" });
  });

  it("does not carry a selected group and path into a different stash", () => {
    const view = render(
      <StashInspector
        repoId="repo-1"
        stash={stash}
        selectedFile={{ stashId: stash.id, group: "index", path: "both.txt" }}
        onSelectFile={vi.fn()}
        onStashAction={vi.fn()}
      />,
    );
    expect(screen.getAllByTitle("both.txt")[0]).toHaveAttribute("aria-selected", "true");

    view.rerender(
      <StashInspector
        repoId="repo-1"
        stash={{ ...stash, id: "other-stash", refName: "stash@{1}" }}
        selectedFile={{ stashId: stash.id, group: "index", path: "both.txt" }}
        onSelectFile={vi.fn()}
        onStashAction={vi.fn()}
      />,
    );

    expect(screen.getAllByTitle("both.txt")[0]).toHaveAttribute("aria-selected", "false");
  });

  it("omits empty groups and renders the honest detached fallback", () => {
    vi.mocked(useStashFiles).mockReturnValue({
      files: {
        staged: [],
        worktree: [{ path: "only.txt", changeType: "modified", additions: 1, deletions: 1 }],
        untracked: [],
        truncated: false,
      },
      loading: false,
      error: null,
    });
    render(
      <StashInspector
        repoId="repo-1"
        stash={{ ...stash, branch: null }}
        selectedFile={null}
        onSelectFile={vi.fn()}
        onStashAction={vi.fn()}
      />,
    );

    expect(screen.getByText("stash.inspector.createdDetached")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "stash.inspector.groupStaged" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "stash.inspector.groupWorktree" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "stash.inspector.groupUntracked" })).not.toBeInTheDocument();
  });

  it("uses the shared loading, error, empty, and truncated states", () => {
    vi.mocked(useStashFiles).mockReturnValue({
      files: { staged: [], worktree: [], untracked: [], truncated: false },
      loading: true,
      error: null,
    });
    const view = render(
      <StashInspector repoId="repo-1" stash={stash} selectedFile={null} onSelectFile={vi.fn()} onStashAction={vi.fn()} />,
    );
    expect(screen.getByText("commits.loading")).toBeInTheDocument();

    vi.mocked(useStashFiles).mockReturnValue({
      files: { staged: [], worktree: [], untracked: [], truncated: false },
      loading: false,
      error: "read failed",
    });
    view.rerender(<StashInspector repoId="repo-1" stash={stash} selectedFile={null} onSelectFile={vi.fn()} onStashAction={vi.fn()} />);
    expect(screen.getByText("read failed")).toBeInTheDocument();

    vi.mocked(useStashFiles).mockReturnValue({
      files: { staged: [], worktree: [], untracked: [], truncated: true },
      loading: false,
      error: null,
    });
    view.rerender(<StashInspector repoId="repo-1" stash={stash} selectedFile={null} onSelectFile={vi.fn()} onStashAction={vi.fn()} />);
    expect(screen.getByText("stash.inspector.empty")).toBeInTheDocument();
    expect(screen.getByText("stash.inspector.truncated")).toBeInTheDocument();
  });
});
