import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
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
    queryFn: () => getBranches(repoId!),
    enabled: repoId !== null,
  });

  return {
    branches: query.data ?? [],
    loading: query.isFetching,
    error: query.error ? String(query.error) : null,
  };
}
