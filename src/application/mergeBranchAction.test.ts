import { describe, expect, it } from "vitest";
import {
  commandPaletteMergeBranches,
  mergeSourceForBranch,
  mergeSourceForCommit,
  mergeSourceForTag,
  mergeSourceLabel,
  mergeSourceRemoteName,
} from "@/application/mergeBranchAction";
import type { BranchInfo } from "@/domain/git";

describe("merge branch application action", () => {
  it("builds the same canonical payload and excludes current/remote palette sources", () => {
    const branches: BranchInfo[] = [
      branch("main", true, false),
      branch("feature", false, false),
      branch("origin/feature", false, true),
    ];
    expect(commandPaletteMergeBranches(branches)).toEqual([branches[1]]);
    expect(mergeSourceForBranch(branches[1])).toEqual({
      refName: "refs/heads/feature",
      kind: "localBranch",
    });
    expect(mergeSourceForBranch(branches[2])).toEqual({
      refName: "refs/remotes/origin/feature",
      kind: "remoteTracking",
    });
  });

  it("extracts the remote name from a remote-tracking source and returns null for a local one", () => {
    expect(mergeSourceRemoteName({ refName: "refs/remotes/origin/feature/payments", kind: "remoteTracking" }))
      .toBe("origin");
    expect(mergeSourceRemoteName({ refName: "refs/heads/feature", kind: "localBranch" })).toBeNull();
  });

  it("builds canonical tag and raw-commit sources with bounded labels", () => {
    const commitId = "0123456789abcdef0123456789abcdef01234567";
    expect(mergeSourceForTag({ name: "v1.0.0" })).toEqual({
      refName: "refs/tags/v1.0.0",
      kind: "tag",
    });
    expect(mergeSourceForCommit({ id: commitId })).toEqual({
      refName: commitId,
      kind: "commit",
    });
    expect(mergeSourceLabel({ refName: "refs/tags/v1.0.0", kind: "tag" })).toBe("v1.0.0");
    expect(mergeSourceLabel({ refName: commitId, kind: "commit" })).toBe("0123456");
  });
});

function branch(name: string, isCurrent: boolean, isRemote: boolean): BranchInfo {
  return {
    name,
    isCurrent,
    isRemote,
    upstream: null,
    ahead: 0,
    behind: 0,
    targetCommitId: "commit",
  };
}
