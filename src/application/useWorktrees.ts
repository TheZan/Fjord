import { useQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import { listWorktrees } from "@/infrastructure/tauriClient";
import type { Worktree } from "@/domain/git";

export interface UseWorktreesResult {
  worktrees: Worktree[];
  loading: boolean;
  error: string | null;
}

export function useWorktrees(repoId: string | null): UseWorktreesResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.worktrees(repoId) : queryKeys.repos.all,
    queryFn: ({ signal }) => listWorktrees(repoId!, signal),
    enabled: repoId !== null,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });

  return {
    worktrees: query.data ?? [],
    loading: query.isPending,
    error: query.error ? userErrorMessage(query.error) : null,
  };
}
