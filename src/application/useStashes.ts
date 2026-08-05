import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { getStashes, invokeErrorMessage } from "@/infrastructure/tauriClient";
import type { StashEntry } from "@/domain/git";

export interface UseStashesResult {
  stashes: StashEntry[];
  loading: boolean;
  error: string | null;
}

/** Stash stack for `repoId`, refreshed by repo-level query invalidation after stash mutations. */
export function useStashes(repoId: string | null): UseStashesResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.stashes(repoId) : queryKeys.repos.all,
    queryFn: () => getStashes(repoId!),
    enabled: repoId !== null,
  });

  return {
    stashes: query.data ?? [],
    loading: query.isFetching,
    error: query.error ? invokeErrorMessage(query.error) : null,
  };
}
