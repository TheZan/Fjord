import type { BranchInfo, MergeSource } from "@/domain/git";

export function mergeSourceForBranch(branch: Pick<BranchInfo, "name" | "isRemote">): MergeSource {
  return {
    refName: branch.isRemote ? `refs/remotes/${branch.name}` : `refs/heads/${branch.name}`,
    kind: branch.isRemote ? "remoteTracking" : "localBranch",
  };
}

export function commandPaletteMergeBranches(branches: BranchInfo[]) {
  return branches.filter((branch) => !branch.isRemote && !branch.isCurrent);
}
