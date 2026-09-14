import type { RepoCondition, RepoHealth } from "@/domain/workspace";
import type { UiOverviewFilter } from "@/domain/generated";

export const HEALTH_FILTER_ORDER: readonly UiOverviewFilter[] = [
  "attention",
  "dirty",
  "ahead",
  "behind",
  "conflicts",
  "wrongBranch",
];

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

export function repoMatchesHealthFilter(
  health: RepoHealth | undefined,
  filter: UiOverviewFilter,
): boolean {
  if (!health) return false;
  switch (filter) {
    case "attention":
      return health.needsAttention;
    case "dirty":
      return repoHasCondition(health, "dirty");
    case "ahead":
      return repoHasCondition(health, "ahead", "diverged");
    case "behind":
      return repoIsBehind(health);
    case "conflicts":
      return repoHasCondition(health, "conflict");
    case "wrongBranch":
      return repoHasCondition(health, "wrongBranch");
  }
}

/** Health chips compose as an OR-set. An empty set deliberately matches all. */
export function repoMatchesHealthFilters(
  health: RepoHealth | undefined,
  filters: ReadonlySet<UiOverviewFilter>,
): boolean {
  if (filters.size === 0) return true;
  for (const filter of filters) {
    if (repoMatchesHealthFilter(health, filter)) return true;
  }
  return false;
}

export function filterRepositoriesByHealth<T extends { id: string }>(
  repositories: readonly T[],
  healthByRepo: Readonly<Record<string, RepoHealth>>,
  filters: ReadonlySet<UiOverviewFilter>,
): T[] {
  if (filters.size === 0) return [...repositories];
  return repositories.filter((repository) =>
    repoMatchesHealthFilters(healthByRepo[repository.id], filters),
  );
}

export interface RepositoryFilterRow {
  workspace: { name: string };
  repo: { id: string; name: string; path: string };
}

/** All Repositories text search composes with the health OR-set using AND. */
export function filterRepositoryRows<T extends RepositoryFilterRow>(
  rows: readonly T[],
  healthByRepo: Readonly<Record<string, RepoHealth>>,
  filters: ReadonlySet<UiOverviewFilter>,
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return rows.filter(({ workspace, repo }) => {
    const textMatches =
      normalizedQuery.length === 0 ||
      [repo.name, repo.path, workspace.name].some((value) =>
        value.toLocaleLowerCase().includes(normalizedQuery),
      );
    return textMatches && repoMatchesHealthFilters(healthByRepo[repo.id], filters);
  });
}

export function serializeHealthFilters(
  filters: ReadonlySet<UiOverviewFilter>,
): UiOverviewFilter[] {
  return HEALTH_FILTER_ORDER.filter((filter) => filters.has(filter));
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
