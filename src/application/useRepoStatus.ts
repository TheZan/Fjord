import { useQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import { getRepoStatus } from "@/infrastructure/tauriClient";
import type { RepoStatus } from "@/domain/git";

export interface UseRepoStatusResult {
  status: RepoStatus | null;
  loading: boolean;
  error: string | null;
}

export function useRepoStatus(repoId: string | null, ready = true): UseRepoStatusResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.status(repoId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getRepoStatus(repoId!, signal),
    enabled: repoId !== null && ready,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });

  return {
    status: query.data ?? null,
    loading: query.isPending,
    error: query.error ? userErrorMessage(query.error) : null,
  };
}
