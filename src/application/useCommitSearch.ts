import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { searchCommitLog } from "@/infrastructure/tauriClient";
import type { CommitSummary } from "@/domain/git";

const SEARCH_LIMIT = 120;

export interface UseCommitSearchResult {
  commits: CommitSummary[];
  loading: boolean;
  error: string | null;
}

export function useCommitSearch(repoId: string | null, query: string): UseCommitSearchResult {
  const normalized = query.trim();
  const enabled = repoId !== null && normalized.length > 0;
  const result = useQuery({
    queryKey: repoId ? queryKeys.repos.commitSearch(repoId, normalized) : queryKeys.repos.all,
    queryFn: ({ signal }) => searchCommitLog(repoId!, normalized, SEARCH_LIMIT, signal),
    enabled,
    staleTime: 30_000,
  });

  return {
    commits: result.data ?? [],
    loading: result.isFetching,
    error: result.error ? String(result.error) : null,
  };
}
