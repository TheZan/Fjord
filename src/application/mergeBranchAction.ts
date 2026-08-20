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

/** The remote name a remote-tracking merge source belongs to, e.g. "origin". */
export function mergeSourceRemoteName(source: MergeSource): string | null {
  if (source.kind !== "remoteTracking") return null;
  const withoutPrefix = source.refName.replace(/^refs\/remotes\//, "");
  const remote = withoutPrefix.split("/", 1)[0];
  return remote || null;
}
