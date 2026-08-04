import { describe, expect, it } from "vitest";
import { computeGraphLayout } from "./graphLayout";
import type { CommitSummary } from "@/domain/git";

function commit(id: string, parentIds: string[]): CommitSummary {
  return {
    id,
    parentIds,
    message: id,
    authorName: "Test",
    authorEmail: "test@example.com",
    authoredAt: "2026-01-01T00:00:00Z",
    refs: [],
  };
}

describe("computeGraphLayout", () => {
  it("keeps a linear history in a single lane", () => {
    const commits = [commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1", [])];
    const { rows, laneCount } = computeGraphLayout(commits);

    expect(laneCount).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0].hasLineAbove).toBe(false); // tip, nothing above
    expect(rows[2].hasLineBelow).toBe(false); // root, nothing below
  });

  it("lays out a branch-then-merge like the api-gateway prototype example", () => {
    // newest -> oldest, mirroring the hand-authored prototype topology:
    // feature tip -> feature commit -> merge (parents: feature-parent, main) -> main tip -> feature draft -> main base -> shared root
    const commits = [
      commit("tip", ["wire"]),
      commit("wire", ["merge"]),
      commit("merge", ["draft", "mainTip"]),
      commit("mainTip", ["base"]),
      commit("draft", ["root"]),
      commit("base", ["root"]),
      commit("root", []),
    ];

    const { rows, laneCount } = computeGraphLayout(commits);
    const byId = Object.fromEntries(rows.map((r) => [r.commit.id, r]));

    expect(laneCount).toBe(2);
    // feature branch stays in one lane throughout
    expect(byId.tip.lane).toBe(byId.wire.lane);
    expect(byId.wire.lane).toBe(byId.merge.lane);
    expect(byId.merge.lane).toBe(byId.draft.lane);

    // main stays in the other lane
    expect(byId.mainTip.lane).toBe(byId.base.lane);
    expect(byId.mainTip.lane).not.toBe(byId.merge.lane);

    // the merge commit records a diverging line into main's lane
    expect(byId.merge.divergingLanes).toEqual([byId.mainTip.lane]);

    // root is a fork point: two lanes converge into it from above
    expect(byId.root.convergingLanes.length).toBe(1);
    expect(byId.root.hasLineBelow).toBe(false);
  });

  it("frees a lane after a root commit so it can be reused", () => {
    const commits = [commit("b", ["shared"]), commit("a", ["shared"]), commit("shared", [])];
    // "a" and "b" both point at "shared" directly (no merge commit) — a
    // simple fork with no intermediate history; both converge on "shared"'s row.
    const { rows, laneCount } = computeGraphLayout(commits);
    const byId = Object.fromEntries(rows.map((r) => [r.commit.id, r]));

    expect(laneCount).toBe(2);
    expect(byId.a.lane).not.toBe(byId.b.lane);
    expect(byId.shared.convergingLanes.length).toBe(1);
  });

  it("handles an octopus merge (more than two parents)", () => {
    const commits = [
      commit("merge", ["a", "b", "c"]),
      commit("a", []),
      commit("b", []),
      commit("c", []),
    ];
    const { rows, laneCount } = computeGraphLayout(commits);
    const merge = rows[0];

    expect(laneCount).toBe(3);
    expect(merge.divergingLanes.length).toBe(2);
  });

  it("returns an empty layout for no commits", () => {
    expect(computeGraphLayout([])).toEqual({ rows: [], laneCount: 0 });
  });
});
