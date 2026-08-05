import { useCallback, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { getCommitLog } from "@/infrastructure/tauriClient";
import type { CommitSummary } from "@/domain/git";

const PAGE_SIZE = 30;

export interface UseCommitLogResult {
  commits: CommitSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
}

/** Paginated commit history for `repoId`, resetting whenever it changes. */
export function useCommitLog(repoId: string | null): UseCommitLogResult {
  const query = useInfiniteQuery({
    queryKey: repoId ? queryKeys.repos.commits(repoId) : queryKeys.repos.all,
    queryFn: ({ pageParam }) => getCommitLog(repoId!, pageParam, PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: repoId !== null,
  });

  const commits = useMemo(
    () => {
      const seen = new Set<string>();
      return (
        query.data?.pages
          .flatMap((page) => page.commits)
          .filter((commit) => {
            if (seen.has(commit.id)) return false;
            seen.add(commit.id);
            return true;
          }) ?? []
      );
    },
    [query.data],
  );

  const loadMore = useCallback(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    void query.fetchNextPage();
  }, [query]);

  return {
    commits,
    loading: query.isFetching,
    error: query.error ? String(query.error) : null,
    hasMore: query.hasNextPage,
    loadMore,
  };
}
