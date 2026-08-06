import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { getCommitDiff } from "@/infrastructure/tauriClient";
import type { FileDiff } from "@/domain/git";

export interface UseCommitDiffResult {
  files: FileDiff[];
  loading: boolean;
  error: string | null;
}

/** Changed-files summary for `commitId` in `repoId`, refetching whenever either changes. */
export function useCommitDiff(repoId: string | null, commitId: string | null): UseCommitDiffResult {
  const query = useQuery({
    queryKey: repoId && commitId ? queryKeys.repos.commitDiff(repoId, commitId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getCommitDiff(repoId!, commitId!, signal),
    enabled: repoId !== null && commitId !== null,
  });

  return {
    files: query.data ?? [],
    loading: query.isFetching,
    error: query.error ? String(query.error) : null,
  };
}
