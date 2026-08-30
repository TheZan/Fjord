import type { RepoCondition, RepoHealth } from "@/domain/workspace";

export function primaryRepoCondition(health: RepoHealth | undefined): RepoCondition | undefined {
  return health?.conditions[0];
}

export function repoNeedsAttention(health: RepoHealth | undefined): boolean {
  return health?.needsAttention ?? false;
}

export function repoHasCondition(
  health: RepoHealth | undefined,
  ...kinds: RepoCondition["kind"][]
): boolean {
  return health?.conditions.some((condition) => kinds.includes(condition.kind)) ?? false;
}

export function repoIsBehind(health: RepoHealth | undefined): boolean {
  return repoHasCondition(health, "behind", "diverged");
}

export interface ExpectedBranchSummary {
  /** Repositories the backend health says are on the workspace's expected branch. */
  onExpected: number;
  /** Repositories whose branch state is trustworthy enough to classify. */
  known: number;
  /** Every repository in the workspace, whether classifiable or not. */
  total: number;
}

/**
 * Counts how many repositories are on the workspace's expected branch, from
 * the backend `RepoHealth` projection alone — never by comparing
 * `RepoStatus.branch` against the workspace setting here. The backend owns the
 * `WrongBranch` rule (docs/specs/workspace-workflows.md §4–§5); duplicating it
 * in the frontend is exactly how the sidebar and the dashboard start to
 * disagree.
 *
 * A repository whose health is missing or carries `Unreadable` has no
 * trustworthy branch state, so it is counted as neither on nor off the branch:
 * it drops out of `known` and the summary says `X of Y known on <branch>`
 * rather than quietly claiming it matches.
 */
export function countOnExpectedBranch(
  repositories: Array<{ id: string }>,
  healthByRepo: Record<string, RepoHealth>,
): ExpectedBranchSummary {
  let onExpected = 0;
  let known = 0;

  for (const repository of repositories) {
    const health = healthByRepo[repository.id];
    if (!health || repoHasCondition(health, "unreadable")) continue;
    known += 1;
    if (!repoHasCondition(health, "wrongBranch")) onExpected += 1;
  }

  return { onExpected, known, total: repositories.length };
}
