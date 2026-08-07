import { useQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import { getWorkingChanges } from "@/infrastructure/tauriClient";
import type { WorkingChanges } from "@/domain/git";

export interface UseWorkingChangesResult {
  changes: WorkingChanges;
  loading: boolean;
  error: string | null;
}

const EMPTY: WorkingChanges = { staged: [], unstaged: [] };

/** Uncommitted work for `repoId`, refreshed only after working-tree mutations. */
export function useWorkingChanges(repoId: string | null): UseWorkingChangesResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.workingChanges(repoId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getWorkingChanges(repoId!, signal),
    enabled: repoId !== null,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });

  return {
    changes: query.data ?? EMPTY,
    loading: query.isPending,
    error: query.error ? userErrorMessage(query.error) : null,
  };
}
