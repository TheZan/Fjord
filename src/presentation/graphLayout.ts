// Lane-assignment for the commit graph — the general algorithm behind what
// was hand-authored per-row in the design prototype. Given commits newest
// first (as `GitBackend::log` returns them), assigns each commit to a
// column ("lane") and records the connector lines needed to draw a real
// branch/merge topology, not just a flat list.
//
// Approach: walk commits top to bottom, tracking which lane each "active"
// branch tip currently occupies (`activeLanes[lane] = commit id that lane
// is waiting to reach`). A commit resolves whichever lane(s) were waiting
// for it — normally one, but more than one when several children point to
// the same parent (a fork, read bottom-to-top) or converge on it (a merge
// target). Its first parent continues in the same lane; any additional
// parents either join a lane that's already waiting for them, or start a
// new lane.

import type { CommitSummary } from "@/domain/git";

export interface GraphRow {
  commit: CommitSummary;
  lane: number;
  /** Lanes with a plain vertical line passing through this row (no dot). */
  passthroughLanes: number[];
  /** Other lanes converging into this commit's dot from above (fork, read bottom-to-top). */
  convergingLanes: number[];
  /** Lanes this commit's extra parents diverge into below (merge parents beyond the first). */
  divergingLanes: number[];
  hasLineAbove: boolean;
  hasLineBelow: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  laneCount: number;
}

export function computeGraphLayout(commits: CommitSummary[]): GraphLayout {
  // `null` = free lane; otherwise the commit id this lane is waiting for.
  const activeLanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let maxLaneCount = 0;

  function allocateLane(): number {
    const free = activeLanes.indexOf(null);
    if (free !== -1) return free;
    activeLanes.push(null);
    return activeLanes.length - 1;
  }

  for (const commit of commits) {
    const matchingLanes: number[] = [];
    activeLanes.forEach((waitingFor, lane) => {
      if (waitingFor === commit.id) matchingLanes.push(lane);
    });

    const hasLineAbove = matchingLanes.length > 0;
    const lane = hasLineAbove ? Math.min(...matchingLanes) : allocateLane();
    const convergingLanes = matchingLanes.filter((l) => l !== lane);

    const passthroughLanes: number[] = [];
    activeLanes.forEach((waitingFor, l) => {
      if (l !== lane && !convergingLanes.includes(l) && waitingFor !== null) {
        passthroughLanes.push(l);
      }
    });

    // Free every lane this commit resolves before reassigning `lane` below —
    // a converging lane that happened to equal `lane` itself is already
    // handled since `lane` gets overwritten next regardless.
    for (const l of matchingLanes) activeLanes[l] = null;

    const divergingLanes: number[] = [];
    const hasLineBelow = commit.parentIds.length > 0;

    if (hasLineBelow) {
      activeLanes[lane] = commit.parentIds[0];

      for (let i = 1; i < commit.parentIds.length; i++) {
        const parentId = commit.parentIds[i];
        const existing = activeLanes.indexOf(parentId);
        if (existing !== -1) {
          divergingLanes.push(existing);
        } else {
          const newLane = allocateLane();
          activeLanes[newLane] = parentId;
          divergingLanes.push(newLane);
        }
      }
    }

    maxLaneCount = Math.max(maxLaneCount, activeLanes.length);
    rows.push({ commit, lane, passthroughLanes, convergingLanes, divergingLanes, hasLineAbove, hasLineBelow });
  }

  return { rows, laneCount: maxLaneCount };
}
