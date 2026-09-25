import { useQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import { getConflicts } from "@/infrastructure/tauriClient";
import type { ConflictSet } from "@/domain/git";

export interface UseConflictsResult {
  conflicts: ConflictSet | null;
  error: string | null;
}

/**
 * The live index's conflict set (conflict-resolution.md §1). Read only while
 * Working Changes reports a conflicted row, so a clean repository costs no
 * extra IPC; the set is keyed under working changes and refreshes with them.
 */
export function useConflicts(repoId: string | null, enabled: boolean): UseConflictsResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.conflicts(repoId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getConflicts(repoId!, signal),
    enabled: repoId !== null && enabled,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });

  return {
    conflicts: enabled ? query.data ?? null : null,
    error: enabled && query.error ? userErrorMessage(query.error) : null,
  };
}
