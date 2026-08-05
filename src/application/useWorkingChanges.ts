import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { getWorkingChanges, invokeErrorMessage } from "@/infrastructure/tauriClient";
import type { WorkingChanges } from "@/domain/git";

export interface UseWorkingChangesResult {
  changes: WorkingChanges;
  loading: boolean;
  error: string | null;
}

const EMPTY: WorkingChanges = { staged: [], unstaged: [] };

/** Uncommitted work for `repoId`, refreshed by repo-level query invalidation after mutations. */
export function useWorkingChanges(repoId: string | null): UseWorkingChangesResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.workingChanges(repoId) : queryKeys.repos.all,
    queryFn: () => getWorkingChanges(repoId!),
    enabled: repoId !== null,
  });

  return {
    changes: query.data ?? EMPTY,
    loading: query.isFetching,
    error: query.error ? invokeErrorMessage(query.error) : null,
  };
}
