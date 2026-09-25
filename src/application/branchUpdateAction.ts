import type { BranchInfo, MergeSource, Worktree } from "@/domain/git";

/**
 * "Update {{branch}} from {{source}}" (branch-merge.md §10.3, P12-MERGE-04):
 * the entry point is a non-checked-out local branch's context menu, and the
 * source is always the branch's configured upstream.
 */
export type BranchUpdateBlocker =
  | "noUpstream"
  | "upstreamMissing"
  | "checkedOut"
  | "upToDate"
  | "diverged";

export interface BranchUpdatePlan {
  /** The upstream as a typed merge source, when it is known locally. */
  source: MergeSource | null;
  /** The upstream's display name (`origin/main`), or null without one. */
  sourceLabel: string | null;
  blocker: BranchUpdateBlocker | null;
  /** True only for `diverged`: offer "Checkout and merge…" instead. */
  offerCheckoutAndMerge: boolean;
}

/**
 * `BranchInfo.upstream` is shortened (`origin/main`, or `main` for a local
 * upstream). A remote-tracking branch of that name wins; otherwise a local
 * branch; otherwise the upstream is not known locally.
 */
export function upstreamSource(
  branch: Pick<BranchInfo, "upstream">,
  remoteBranchNames: readonly string[],
  localBranchNames: readonly string[],
): MergeSource | null {
  const upstream = branch.upstream;
  if (!upstream) return null;
  if (remoteBranchNames.includes(upstream)) {
    return { refName: `refs/remotes/${upstream}`, kind: "remoteTracking" };
  }
  if (localBranchNames.includes(upstream)) {
    return { refName: `refs/heads/${upstream}`, kind: "localBranch" };
  }
  return null;
}

export function branchUpdatePlan(
  branch: BranchInfo,
  branches: readonly BranchInfo[],
  worktrees: readonly Pick<Worktree, "branch">[],
): BranchUpdatePlan {
  const source = upstreamSource(
    branch,
    branches.filter((candidate) => candidate.isRemote).map((candidate) => candidate.name),
    branches.filter((candidate) => !candidate.isRemote).map((candidate) => candidate.name),
  );
  const plan = (blocker: BranchUpdateBlocker | null): BranchUpdatePlan => ({
    source,
    sourceLabel: branch.upstream,
    blocker,
    offerCheckoutAndMerge: blocker === "diverged",
  });
  if (!branch.upstream) return plan("noUpstream");
  if (!source) return plan("upstreamMissing");
  if (branch.isCurrent || worktrees.some((worktree) => worktree.branch === branch.name)) {
    return plan("checkedOut");
  }
  if (branch.behind === 0) return plan("upToDate");
  if (branch.ahead > 0) return plan("diverged");
  return plan(null);
}
