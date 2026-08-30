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
