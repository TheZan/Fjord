import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import {
  REPOSITORY_QUERY_GC_TIME,
  REPOSITORY_QUERY_STALE_TIME,
} from "@/application/repositoryQueryPolicy";
import { getTags } from "@/infrastructure/tauriClient";
import type { TagInfo } from "@/domain/git";

export interface UseTagsResult {
  tags: TagInfo[];
  loading: boolean;
  error: string | null;
}

/** Fetches tags for `repoId`, refetching whenever it changes. `null` means no repo selected. */
export function useTags(repoId: string | null): UseTagsResult {
  const query = useQuery({
    queryKey: repoId ? queryKeys.repos.tags(repoId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getTags(repoId!, signal),
    enabled: repoId !== null,
    staleTime: REPOSITORY_QUERY_STALE_TIME,
    gcTime: REPOSITORY_QUERY_GC_TIME,
  });

  return {
    tags: query.data ?? [],
    loading: query.isPending,
    error: query.error ? String(query.error) : null,
  };
}
