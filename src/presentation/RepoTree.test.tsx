import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBranches } from "@/application/useBranches";
import { useStashes } from "@/application/useStashes";
import { useTags } from "@/application/useTags";
import { RepoTree } from "@/presentation/RepoTree";
import type { BranchInfo, StashEntry, TagInfo } from "@/domain/git";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, values?: Record<string, unknown>) =>
      key === "tree.filterCount"
        ? `${values?.matched}/${values?.total}`
        : key === "context.mergeInto"
          ? `Merge ${values?.source} into ${values?.target}…`
          : key === "context.squashMergeInto"
            ? `Squash merge ${values?.source} into ${values?.target}…`
            : key,
  }),
}));

vi.mock("@/application/useBranches", () => ({ useBranches: vi.fn() }));
vi.mock("@/application/useStashes", () => ({ useStashes: vi.fn() }));
vi.mock("@/application/useTags", () => ({ useTags: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      size: 30,
      start: index * 30,
    })),
  }),
}));

const branches: BranchInfo[] = [
  { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main", ahead: 2, behind: 1, targetCommitId: "aaa" },
  { name: "feature/ui", isCurrent: false, isRemote: false, upstream: null, ahead: 0, behind: 0, targetCommitId: "bbb" },
  { name: "origin/release", isCurrent: false, isRemote: true, upstream: null, ahead: 0, behind: 0, targetCommitId: "ccc" },
  { name: "origin/HEAD", isCurrent: false, isRemote: true, upstream: null, ahead: 0, behind: 0, targetCommitId: "aaa" },
];
const tags: TagInfo[] = [{ name: "v1.0", targetCommitId: "abcdef012345" }];
const stashes: StashEntry[] = [
  {
    id: "stash-oid-newest",
    index: 0,
    refName: "stash@{0}",
    message: "On develop: Payment validation WIP",
    title: "Payment validation WIP",
    base: "1111111111111111111111111111111111111111",
    branch: "develop",
    createdAt: "2026-08-24T10:00:00Z",
    filesChanged: 2,
    hasIndexState: true,
    hasUntracked: false,
  },
  {
    id: "stash-oid-detached",
    index: 2,
    refName: "stash@{2}",
    message: "Detached experiment with full message match",
    title: "Experiment",
    base: "abcdef0123456789abcdef0123456789abcdef01",
    branch: null,
    createdAt: "2026-08-23T10:00:00Z",
    filesChanged: 1,
    hasIndexState: false,
    hasUntracked: true,
  },
  {
    id: "stash-oid-similar-title",
    index: 1,
    refName: "stash@{1}",
    message: "On main: Payment validation WIP",
    title: "Payment validation WIP",
    base: "2222222222222222222222222222222222222222",
    branch: "main",
    createdAt: "2026-08-22T10:00:00Z",
    filesChanged: 3,
    hasIndexState: false,
    hasUntracked: false,
  },
];

describe("RepoTree", () => {
  beforeEach(() => {
    vi.mocked(useBranches).mockReturnValue({ branches, loading: false, error: null });
    vi.mocked(useTags).mockReturnValue({ tags, loading: false, error: null });
    vi.mocked(useStashes).mockReturnValue({ stashes, loading: false, error: null });
  });

  it("groups refs, suppresses remote HEAD, and filters case-insensitively", () => {
    render(<RepoTree repoId="repo-1" />);

    expect(screen.getByRole("button", { name: /main/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "release" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /tree.remote/ }));
    fireEvent.click(screen.getByRole("button", { name: /tree.tags/ }));
    expect(screen.getByRole("button", { name: "release" })).toBeInTheDocument();
    expect(screen.queryByText("HEAD")).not.toBeInTheDocument();
    expect(screen.getByText("v1.0")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("tree.filterPlaceholder"), { target: { value: " REL " } });
    expect(screen.getByText("1/7")).toBeInTheDocument();
    expect(screen.getAllByText("tree.noMatches")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "release" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "tree.clearFilter" }));
    expect(screen.queryByText("1/7")).not.toBeInTheDocument();
  });

  it("renders Stashes after Tags with the exact count and backend order", () => {
    const { container } = render(<RepoTree repoId="repo-1" />);
    const tagsHeader = screen.getByRole("button", { name: /tree.tags/ });
    const stashesHeader = screen.getByRole("button", { name: /tree.stashes.*3/ });

    expect(tagsHeader.compareDocumentPosition(stashesHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("[data-stash-id]")).toHaveLength(0);

    fireEvent.click(stashesHeader);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-stash-id]"), (row) => row.dataset.stashId),
    ).toEqual(stashes.map((entry) => entry.id));
    expect(screen.getByText("develop · stash@{0}")).toBeInTheDocument();
    expect(screen.getByText("abcdef0 · stash@{2}")).toBeInTheDocument();
  });

  it("selects duplicate-titled stash rows by stable StashId", () => {
    const onSelectStash = vi.fn();
    const { container } = render(<RepoTree repoId="repo-1" onSelectStash={onSelectStash} />);
    fireEvent.click(screen.getByRole("button", { name: /tree.stashes/ }));

    const rows = container.querySelectorAll<HTMLButtonElement>("[data-stash-id='stash-oid-similar-title']");
    fireEvent.click(rows[0]);
    expect(onSelectStash).toHaveBeenCalledWith("stash-oid-similar-title");
  });

  it("opens the typed stash-menu seam from mouse and keyboard and restores focus", () => {
    const onStashContextMenu = vi.fn();
    const { container } = render(
      <RepoTree repoId="repo-1" onStashContextMenu={onStashContextMenu} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /tree.stashes/ }));
    const row = container.querySelector<HTMLButtonElement>("[data-stash-id='stash-oid-detached']")!;

    fireEvent.contextMenu(row, { clientX: 12, clientY: 34 });
    expect(onStashContextMenu).toHaveBeenLastCalledWith("stash-oid-detached");
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole("menu", { name: "tree.stashes" }), { key: "Escape" });
    expect(row).toHaveFocus();

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(onStashContextMenu).toHaveBeenLastCalledWith("stash-oid-detached");
    fireEvent.keyDown(screen.getByRole("menu", { name: "tree.stashes" }), { key: "Escape" });
    expect(row).toHaveFocus();

    fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(onStashContextMenu).toHaveBeenLastCalledWith("stash-oid-detached");
    fireEvent.keyDown(screen.getByRole("menu", { name: "tree.stashes" }), { key: "Escape" });
    expect(row).toHaveFocus();
  });

  it("filters stashes by title or full message without reordering them", () => {
    const { container } = render(<RepoTree repoId="repo-1" />);
    fireEvent.click(screen.getByRole("button", { name: /tree.stashes/ }));

    fireEvent.change(screen.getByPlaceholderText("tree.filterPlaceholder"), {
      target: { value: "payment validation" },
    });
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-stash-id]"), (row) => row.dataset.stashId),
    ).toEqual(["stash-oid-newest", "stash-oid-similar-title"]);

    fireEvent.change(screen.getByPlaceholderText("tree.filterPlaceholder"), {
      target: { value: "full message match" },
    });
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("[data-stash-id]"), (row) => row.dataset.stashId),
    ).toEqual(["stash-oid-detached"]);
  });

  it("keeps the empty Stashes section and renders its localized empty state", () => {
    vi.mocked(useStashes).mockReturnValue({ stashes: [], loading: false, error: null });
    render(<RepoTree repoId="repo-1" />);

    const header = screen.getByRole("button", { name: /tree.stashes.*0/ });
    expect(screen.queryByText("stash.empty")).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.getByText("stash.empty")).toBeInTheDocument();
  });

  it("shows upstream divergence and a persistent publish action when the current branch is untracked", () => {
    const onPublishBranch = vi.fn();
    const { rerender } = render(<RepoTree repoId="repo-1" onPublishBranch={onPublishBranch} />);

    expect(screen.getByText(/origin\/main.*↑2.*↓1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "remotes.pushAndSetUpstream" })).not.toBeInTheDocument();

    vi.mocked(useBranches).mockReturnValue({
      branches: [{ ...branches[0], upstream: null, ahead: 0, behind: 0 }],
      loading: false,
      error: null,
    });
    rerender(<RepoTree repoId="repo-1" onPublishBranch={onPublishBranch} />);
    fireEvent.click(screen.getByRole("button", { name: "remotes.pushAndSetUpstream" }));
    expect(onPublishBranch).toHaveBeenCalledWith("main");

    vi.mocked(useBranches).mockReturnValue({
      branches: [{ ...branches[0], upstream: "origin/main", ahead: 0, behind: 0 }],
      loading: false,
      error: null,
    });
    rerender(<RepoTree repoId="repo-1" onPublishBranch={onPublishBranch} />);
    expect(screen.getByText(/origin\/main/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "remotes.pushAndSetUpstream" })).not.toBeInTheDocument();
  });

  it("selects, checks out, and moves keyboard focus between visible branches", () => {
    const onSelectBranch = vi.fn();
    const onCheckout = vi.fn();
    render(
      <RepoTree repoId="repo-1" onSelectBranch={onSelectBranch} onCheckout={onCheckout} />,
    );
    const main = screen.getByRole("button", { name: /main/ });
    const feature = screen.getByRole("button", { name: "feature/ui" });

    fireEvent.click(feature);
    fireEvent.doubleClick(feature);
    fireEvent.keyDown(feature, { key: "Enter", ctrlKey: true });
    expect(onSelectBranch).toHaveBeenCalledWith("feature/ui");
    expect(onCheckout).toHaveBeenCalledTimes(2);

    main.focus();
    fireEvent.keyDown(main, { key: "ArrowDown" });
    expect(feature).toHaveFocus();
    fireEvent.keyDown(feature, { key: "Home" });
    expect(main).toHaveFocus();
  });

  it("dispatches branch and tag context-menu actions with their source ref", () => {
    const onBranchContextAction = vi.fn();
    const onTagContextAction = vi.fn();
    render(
      <RepoTree
        repoId="repo-1"
        onBranchContextAction={onBranchContextAction}
        onTagContextAction={onTagContextAction}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "feature/ui" }), { clientX: 12, clientY: 34 });
    fireEvent.click(screen.getByRole("menuitem", { name: "context.deleteBranch" }));
    expect(onBranchContextAction).toHaveBeenCalledWith("delete", branches[1], ["origin/release"]);

    fireEvent.click(screen.getByRole("button", { name: /tree.tags/ }));
    fireEvent.contextMenu(screen.getByText("v1.0").closest("li")!, { clientX: 8, clientY: 16 });
    fireEvent.click(screen.getByRole("menuitem", { name: "context.deleteTag" }));
    expect(onTagContextAction).toHaveBeenCalledWith("delete", tags[0]);
  });

  it("exposes upstream management from a local branch context menu", () => {
    const onBranchContextAction = vi.fn();
    render(<RepoTree repoId="repo-1" onBranchContextAction={onBranchContextAction} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "feature/ui" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "context.setUpstream" }));
    expect(onBranchContextAction).toHaveBeenCalledWith(
      "setUpstream",
      branches[1],
      ["origin/release"],
    );
  });

  it("names both merge refs, dispatches the exact branch, and restores keyboard focus", async () => {
    const onBranchContextAction = vi.fn();
    render(<RepoTree repoId="repo-1" onBranchContextAction={onBranchContextAction} />);
    const feature = screen.getByRole("button", { name: "feature/ui" });
    feature.focus();
    fireEvent.keyDown(feature, { key: "F10", shiftKey: true });
    const merge = screen.getByRole("menuitem", { name: "Merge feature/ui into main…" });
    expect(merge).toBeEnabled();
    fireEvent.click(merge);
    expect(onBranchContextAction).toHaveBeenCalledWith("merge", branches[1], ["origin/release"]);

    feature.focus();
    fireEvent.keyDown(feature, { key: "ContextMenu" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(feature).toHaveFocus();
  });

  it("keeps the current-branch merge entry visible with a stated disabled reason", () => {
    render(<RepoTree repoId="repo-1" />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /main/ }));
    const current = screen.getByRole("menuitem", { name: "Merge main into main…" });
    expect(current).toBeDisabled();
    expect(current).toHaveAttribute("title", "merge.blocked.sourceIsCurrentBranch");
  });

  it("offers an enabled merge entry for a remote-tracking branch and dispatches its remote-tracking source", () => {
    const onBranchContextAction = vi.fn();
    render(<RepoTree repoId="repo-1" onBranchContextAction={onBranchContextAction} />);
    fireEvent.click(screen.getByRole("button", { name: /tree.remote/ }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "release" }));
    const remote = screen.getByRole("menuitem", { name: "Merge origin/release into main…" });
    expect(remote).toBeEnabled();
    fireEvent.click(remote);
    expect(onBranchContextAction).toHaveBeenCalledWith("merge", branches[2], ["origin/release"]);
  });

  it("offers a squash-merge entry alongside merge, disabled/enabled by the same rules", () => {
    const onBranchContextAction = vi.fn();
    render(<RepoTree repoId="repo-1" onBranchContextAction={onBranchContextAction} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: /main/ }));
    const current = screen.getByRole("menuitem", { name: "Squash merge main into main…" });
    expect(current).toBeDisabled();
    expect(current).toHaveAttribute("title", "merge.blocked.sourceIsCurrentBranch");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.contextMenu(screen.getByRole("button", { name: "feature/ui" }));
    const squashMerge = screen.getByRole("menuitem", { name: "Squash merge feature/ui into main…" });
    expect(squashMerge).toBeEnabled();
    fireEvent.click(squashMerge);
    expect(onBranchContextAction).toHaveBeenCalledWith("squashMerge", branches[1], ["origin/release"]);
  });

  it("blocks checkout gestures and explains the disabled context action", () => {
    const onCheckout = vi.fn();
    render(
      <RepoTree
        repoId="repo-1"
        onCheckout={onCheckout}
        checkoutDisabledReason="operation in progress"
      />,
    );
    const feature = screen.getByRole("button", { name: "feature/ui" });

    fireEvent.doubleClick(feature);
    fireEvent.keyDown(feature, { key: "Enter", ctrlKey: true });
    expect(onCheckout).not.toHaveBeenCalled();
    expect(feature).toHaveAttribute("title", "operation in progress");

    fireEvent.contextMenu(feature);
    const checkout = screen.getByRole("menuitem", { name: /context.checkout/ });
    expect(checkout).toBeDisabled();
    expect(checkout).toHaveAttribute("title", "operation in progress");
  });
});
