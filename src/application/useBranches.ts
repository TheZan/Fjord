import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import { getBranches } from "@/infrastructure/tauriClient";
import type { BranchInfo } from "@/domain/git";

export interface UseBranchesResult {
  branches: BranchInfo[];
  loading: boolean;
  error: string | null;
}

/** Fetches branches for `repoId`, refetching whenever it changes. `null` means no repo selected. */
export function useBranches(repoId: string | null): UseBranchesResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.branches(repoId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getBranches(repoId!, signal),
    enabled: repoId !== null,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });

  return {
    branches: query.data ?? [],
    loading: query.isPending,
    error: query.error ? String(query.error) : null,
  };
}
