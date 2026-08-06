import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_LOG_PAGE_SIZE,
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import {
  getBranches,
  getCommitLog,
  getRepoStatus,
  getTags,
  getWorkingChanges,
} from "@/infrastructure/tauriClient";
import type { CommitPage } from "@/domain/git";

/** Starts only the reads needed by the repository's first visible frame. */
export function warmRepositoryData(queryClient: QueryClient, repoId: string) {
  const queryPolicy = {
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  };

  return Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.repos.status(repoId),
      queryFn: ({ signal }) => getRepoStatus(repoId, signal),
      ...queryPolicy,
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.repos.branches(repoId),
      queryFn: ({ signal }) => getBranches(repoId, signal),
      ...queryPolicy,
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.repos.tags(repoId),
      queryFn: ({ signal }) => getTags(repoId, signal),
      ...queryPolicy,
    }),
    queryClient.prefetchInfiniteQuery({
      queryKey: queryKeys.repos.commits(repoId),
      queryFn: ({ pageParam, signal }) =>
        getCommitLog(repoId, pageParam, REPOSITORY_LOG_PAGE_SIZE, signal),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage: CommitPage) => lastPage.nextCursor,
      ...queryPolicy,
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.repos.workingChanges(repoId),
      queryFn: ({ signal }) => getWorkingChanges(repoId, signal),
      ...queryPolicy,
    }),
  ]);
}
