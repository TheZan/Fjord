import { describe, expect, it } from "vitest";
import { branchUpdatePlan, upstreamSource } from "@/application/branchUpdateAction";
import type { BranchInfo } from "@/domain/git";

function branch(overrides: Partial<BranchInfo>): BranchInfo {
  return {
    name: "release",
    isCurrent: false,
    isRemote: false,
    upstream: "origin/release",
    ahead: 0,
    behind: 2,
    targetCommitId: "abc",
    ...overrides,
  };
}

const remote = branch({ name: "origin/release", isRemote: true, upstream: null, behind: 0 });

describe("branchUpdatePlan (P12-MERGE-04)", () => {
  it("offers a fast-forward from the configured upstream", () => {
    expect(branchUpdatePlan(branch({}), [branch({}), remote], [])).toEqual({
      source: { refName: "refs/remotes/origin/release", kind: "remoteTracking" },
      sourceLabel: "origin/release",
      blocker: null,
      offerCheckoutAndMerge: false,
    });
  });

  it("names every refusal, in order", () => {
    expect(branchUpdatePlan(branch({ upstream: null }), [remote], []).blocker).toBe("noUpstream");
    expect(branchUpdatePlan(branch({ upstream: "origin/gone" }), [remote], []).blocker).toBe("upstreamMissing");
    expect(branchUpdatePlan(branch({ isCurrent: true }), [remote], []).blocker).toBe("checkedOut");
    expect(branchUpdatePlan(branch({}), [remote], [{ branch: "release" }]).blocker).toBe("checkedOut");
    expect(branchUpdatePlan(branch({ behind: 0 }), [remote], []).blocker).toBe("upToDate");
    const diverged = branchUpdatePlan(branch({ ahead: 1 }), [remote], []);
    expect(diverged.blocker).toBe("diverged");
    expect(diverged.offerCheckoutAndMerge).toBe(true);
  });

  it("resolves a local upstream to a local-branch source", () => {
    expect(upstreamSource({ upstream: "main" }, ["origin/main"], ["main"])).toEqual({
      refName: "refs/heads/main",
      kind: "localBranch",
    });
    expect(upstreamSource({ upstream: "origin/main" }, ["origin/main"], ["main"])).toEqual({
      refName: "refs/remotes/origin/main",
      kind: "remoteTracking",
    });
    expect(upstreamSource({ upstream: null }, [], [])).toBeNull();
  });
});
