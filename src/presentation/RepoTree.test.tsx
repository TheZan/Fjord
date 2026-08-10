import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBranches } from "@/application/useBranches";
import { useTags } from "@/application/useTags";
import { RepoTree } from "@/presentation/RepoTree";
import type { BranchInfo, TagInfo } from "@/domain/git";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      key === "tree.filterCount" ? `${values?.matched}/${values?.total}` : key,
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
  { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main", targetCommitId: "aaa" },
  { name: "feature/ui", isCurrent: false, isRemote: false, upstream: null, targetCommitId: "bbb" },
  { name: "origin/release", isCurrent: false, isRemote: true, upstream: null, targetCommitId: "ccc" },
  { name: "origin/HEAD", isCurrent: false, isRemote: true, upstream: null, targetCommitId: "aaa" },
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
    expect(onBranchContextAction).toHaveBeenCalledWith("delete", branches[1]);

    fireEvent.click(screen.getByRole("button", { name: /tree.tags/ }));
    fireEvent.contextMenu(screen.getByText("v1.0").closest("li")!, { clientX: 8, clientY: 16 });
    fireEvent.click(screen.getByRole("menuitem", { name: "context.deleteTag" }));
    expect(onTagContextAction).toHaveBeenCalledWith("delete", tags[0]);
  });
});
