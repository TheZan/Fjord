import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import type { RepositoryGenerationScope } from "@/infrastructure/repositoryGenerations";

export type RepoDataScope = RepositoryGenerationScope;

export async function invalidateRepoData(
  queryClient: QueryClient,
  repoId: string,
  workspaceId: string,
  scopes: RepoDataScope[],
) {
  const keys: QueryKey[] = [];
  const requested = new Set(scopes);

  if (requested.has("status")) {
    keys.push(queryKeys.repos.status(repoId), queryKeys.workspaces.status(workspaceId));
  }
  if (requested.has("operation")) keys.push(queryKeys.repos.operationState(repoId));
  if (requested.has("working")) {
    keys.push(queryKeys.repos.workingChanges(repoId), queryKeys.repos.fileDiffs(repoId));
  }
  if (requested.has("history")) {
    keys.push(queryKeys.repos.commits(repoId), queryKeys.repos.commitSearches(repoId));
  }
  if (requested.has("refs")) {
    keys.push(queryKeys.repos.branches(repoId), queryKeys.repos.tags(repoId));
  }
  if (requested.has("stashes")) keys.push(queryKeys.repos.stashes(repoId));

  await Promise.all(
    keys.map(async (queryKey) => {
      await queryClient.cancelQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey });
    }),
  );
}
