import { useQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import type { RepoOperationState } from "@/domain/generated";
import { getRepoOperationState } from "@/infrastructure/tauriClient";

export interface UseRepoOperationStateResult {
  state: RepoOperationState | null;
  loading: boolean;
  error: string | null;
}

export function useRepoOperationState(
  repoId: string | null,
  ready = true,
): UseRepoOperationStateResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.operationState(repoId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getRepoOperationState(repoId!, signal),
    enabled: repoId !== null && ready,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });

  return {
    state: query.data ?? null,
    loading: query.isPending,
    error: query.error ? userErrorMessage(query.error) : null,
  };
}
