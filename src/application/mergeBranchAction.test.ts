import { describe, expect, it } from "vitest";
import {
  commandPaletteMergeBranches,
  mergeSourceForBranch,
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
