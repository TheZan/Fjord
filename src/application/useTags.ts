import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
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
  });

  return {
    tags: query.data ?? [],
    loading: query.isFetching,
    error: query.error ? String(query.error) : null,
  };
}
