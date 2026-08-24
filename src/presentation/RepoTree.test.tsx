import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBranches } from "@/application/useBranches";
import { useTags } from "@/application/useTags";
import { RepoTree } from "@/presentation/RepoTree";
import type { BranchInfo, TagInfo } from "@/domain/git";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
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

describe("RepoTree", () => {
  beforeEach(() => {
    vi.mocked(useBranches).mockReturnValue({ branches, loading: false, error: null });
    vi.mocked(useTags).mockReturnValue({ tags, loading: false, error: null });
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
    expect(screen.getByText("1/4")).toBeInTheDocument();
    expect(screen.getAllByText("tree.noMatches")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "release" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "tree.clearFilter" }));
    expect(screen.queryByText("1/4")).not.toBeInTheDocument();
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
