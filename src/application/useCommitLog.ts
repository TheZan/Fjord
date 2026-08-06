import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_LOG_PAGE_SIZE,
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import { getCommitLog } from "@/infrastructure/tauriClient";
import type { CommitPage, CommitSummary, LogCursor } from "@/domain/git";

const BRANCH_SEEK_PAGE_SIZE = 240;

export interface UseCommitLogResult {
  commits: CommitSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  loadingUntilCommitId: string | null;
  loadUntilCommit: (commitId: string) => Promise<boolean>;
}

/** Paginated commit history for `repoId`, resetting whenever it changes. */
export function useCommitLog(repoId: string | null): UseCommitLogResult {
  const queryClient = useQueryClient();
  const activeSeekPromisesRef = useRef(new Map<string, Promise<boolean>>());
  const seekGenerationRef = useRef(0);
  const [loadingUntilCommitId, setLoadingUntilCommitId] = useState<string | null>(null);
  const queryKey = repoId ? queryKeys.repos.commits(repoId) : queryKeys.repos.all;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      getCommitLog(repoId!, pageParam, REPOSITORY_LOG_PAGE_SIZE, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: repoId !== null,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
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

  useEffect(
    () => () => {
      seekGenerationRef.current += 1;
      activeSeekPromisesRef.current.clear();
    },
    [repoId],
  );

  const loadMore = useCallback(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    void query.fetchNextPage();
  }, [query]);

  const loadUntilCommit = useCallback(
    async (commitId: string) => {
      if (!repoId) return false;
      if (commits.some((commit) => commit.id === commitId)) return true;

      const activeSeek = activeSeekPromisesRef.current.get(commitId);
      if (activeSeek) return activeSeek;

      const generation = seekGenerationRef.current + 1;
      seekGenerationRef.current = generation;
      const promise = (async () => {
        setLoadingUntilCommitId(commitId);
        try {
          let cached = queryClient.getQueryData<InfiniteData<CommitPage, LogCursor | null>>(queryKey);
          let cursor = cached?.pages.at(-1)?.nextCursor ?? null;
          if (!cursor && cached && cached.pages.length > 0) return false;

          while (cursor) {
            const pageCursor = cursor;
            const page = await getCommitLog(repoId, pageCursor, BRANCH_SEEK_PAGE_SIZE);
            if (seekGenerationRef.current !== generation) return false;
            const found = page.commits.some((commit) => commit.id === commitId);

            queryClient.setQueryData<InfiniteData<CommitPage, LogCursor | null>>(queryKey, (current) =>
              appendCommitPage(current, page, pageCursor),
            );

            if (found) return true;
            cursor = page.nextCursor;
            cached = queryClient.getQueryData<InfiniteData<CommitPage, LogCursor | null>>(queryKey);
            if (cached?.pages.some((cachedPage) => cachedPage.commits.some((commit) => commit.id === commitId))) {
              return true;
            }
          }

          return false;
        } finally {
          if (seekGenerationRef.current === generation) {
            setLoadingUntilCommitId((current) => (current === commitId ? null : current));
          }
          activeSeekPromisesRef.current.delete(commitId);
        }
      })();

      activeSeekPromisesRef.current.set(commitId, promise);
      return promise;
    },
    [commits, queryClient, queryKey, repoId],
  );

  return {
    commits,
    loading: query.isPending,
    error: query.error ? String(query.error) : null,
    hasMore: query.hasNextPage,
    loadMore,
    loadingUntilCommitId,
    loadUntilCommit,
  };
}

function appendCommitPage(
  current: InfiniteData<CommitPage, LogCursor | null> | undefined,
  page: CommitPage,
  pageParam: LogCursor,
): InfiniteData<CommitPage, LogCursor | null> {
  const existing = current ?? { pages: [], pageParams: [] };
  const seen = new Set(existing.pages.flatMap((cachedPage) => cachedPage.commits.map((commit) => commit.id)));
  const commits = page.commits.filter((commit) => !seen.has(commit.id));
  return {
    pages: [...existing.pages, { ...page, commits }],
    pageParams: [...existing.pageParams, pageParam],
  };
}
