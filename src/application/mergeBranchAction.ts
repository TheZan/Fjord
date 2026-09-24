import type { BranchInfo, CommitSummary, MergeSource, TagInfo } from "@/domain/git";

export function mergeSourceForBranch(branch: Pick<BranchInfo, "name" | "isRemote">): MergeSource {
  return {
    refName: branch.isRemote ? `refs/remotes/${branch.name}` : `refs/heads/${branch.name}`,
    kind: branch.isRemote ? "remoteTracking" : "localBranch",
  };
}

export function mergeSourceForTag(tag: Pick<TagInfo, "name">): MergeSource {
  return { refName: `refs/tags/${tag.name}`, kind: "tag" };
}

export function mergeSourceForCommit(commit: Pick<CommitSummary, "id">): MergeSource {
  return { refName: commit.id, kind: "commit" };
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

export function mergeSourceLabel(source: MergeSource) {
  return source.refName
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/tags\//, "")
    .replace(/^([0-9a-f]{7})[0-9a-f]{33}$/i, "$1");
}
