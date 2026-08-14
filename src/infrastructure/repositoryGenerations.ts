import type { GenerationSet } from "@/domain/generated";

export type RepositoryGenerationScope =
  | "status"
  | "operation"
  | "working"
  | "history"
  | "refs"
  | "stashes";
export type GenerationDomain = keyof GenerationSet;

const dependencies: Record<RepositoryGenerationScope, GenerationDomain[]> = {
  status: ["workingTree", "refs", "config"],
  operation: ["workingTree", "refs"],
  working: ["workingTree"],
  history: ["history"],
  refs: ["refs", "config"],
  stashes: ["stash"],
};

type ScopeObservation = Partial<Record<GenerationDomain, number>>;
const observed = new Map<
  string,
  Partial<Record<RepositoryGenerationScope, ScopeObservation>>
>();

/** Records only generations that the completed query actually depended on. */
export function observeRepositoryGenerations(
  repoId: string,
  generations: GenerationSet,
  scope: RepositoryGenerationScope,
) {
  const repository = observed.get(repoId) ?? {};
  const current = repository[scope] ?? {};
  for (const domain of dependencies[scope]) {
    current[domain] = Math.max(current[domain] ?? 0, generations[domain]);
  }
  repository[scope] = current;
  observed.set(repoId, repository);
}

/** Returns cached query groups whose dependency generation has advanced. */
export function changedRepositoryScopes(
  repoId: string,
  generations: GenerationSet,
): RepositoryGenerationScope[] {
  const repository = observed.get(repoId);
  if (!repository) return [];

  return (Object.keys(dependencies) as RepositoryGenerationScope[]).filter((scope) => {
    const current = repository[scope];
    if (!current) return false;
    return dependencies[scope].some((domain) => {
      const seen = current[domain];
      return seen !== undefined && generations[domain] > seen;
    });
  });
}

export function forgetRepositoryGenerations(repoId?: string) {
  if (repoId) observed.delete(repoId);
  else observed.clear();
}
