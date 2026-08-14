import { useCallback, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import type { FileDiff, ReflogEntry } from "@/domain/git";
import { getRecoveryDiff, getReflog, getReflogRefs } from "@/infrastructure/tauriClient";

const REFLOG_PAGE_SIZE = 50;

export function useReflog(repoId: string, refName: string | null, ready: boolean) {
  const logQuery = useInfiniteQuery({
    queryKey: queryKeys.repos.reflog(repoId, refName),
    queryFn: ({ pageParam, signal }) =>
      getReflog(repoId, refName, pageParam, REFLOG_PAGE_SIZE, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: ready,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });
  const refsQuery = useQuery({
    queryKey: queryKeys.repos.reflogRefs(repoId),
    queryFn: ({ signal }) => getReflogRefs(repoId, signal),
    enabled: ready,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });
  const entries = useMemo(() => {
    const seen = new Set<number>();
    return (logQuery.data?.pages.flatMap((page) => page.entries) ?? []).filter((entry) => {
      if (seen.has(entry.index)) return false;
      seen.add(entry.index);
      return true;
    });
  }, [logQuery.data]);
  const loadMore = useCallback(() => {
    if (logQuery.hasNextPage && !logQuery.isFetchingNextPage) void logQuery.fetchNextPage();
  }, [logQuery]);

  return {
    entries,
    refs: refsQuery.data ?? [],
    loading: logQuery.isPending || refsQuery.isPending,
    loadingMore: logQuery.isFetchingNextPage,
    hasMore: Boolean(logQuery.hasNextPage),
    loadMore,
    error: logQuery.error || refsQuery.error
      ? userErrorMessage(logQuery.error ?? refsQuery.error)
      : null,
  };
}

export function useRecoveryDiff(repoId: string, entry: ReflogEntry | null, ready: boolean): {
  files: FileDiff[];
  loading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: entry ? queryKeys.repos.recoveryDiff(repoId, entry.newId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getRecoveryDiff(repoId, entry!.newId, signal),
    enabled: ready && entry !== null && entry.commit !== null,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });
  return {
    files: query.data ?? [],
    loading: ready && entry !== null && entry.commit !== null && query.isPending,
    error: query.error ? userErrorMessage(query.error) : null,
  };
}
