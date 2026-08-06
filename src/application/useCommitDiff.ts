import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { getCommitDiff, getCommitFiles } from "@/infrastructure/tauriClient";
import type { FileDiff } from "@/domain/git";

export interface UseCommitDiffResult {
  files: FileDiff[];
  loading: boolean;
  statsLoading: boolean;
  statsReady: boolean;
  error: string | null;
}

/** Changed-files summary for `commitId` in `repoId`, refetching whenever either changes. */
export function useCommitDiff(repoId: string | null, commitId: string | null): UseCommitDiffResult {
  const filesQuery = useQuery({
    queryKey: repoId && commitId ? queryKeys.repos.commitFiles(repoId, commitId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getCommitFiles(repoId!, commitId!, signal),
    enabled: repoId !== null && commitId !== null,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1_000,
  });
  const statsEnabled = repoId !== null && commitId !== null && filesQuery.data !== undefined;
  const statsQuery = useQuery({
    queryKey: repoId && commitId ? queryKeys.repos.commitDiff(repoId, commitId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getCommitDiff(repoId!, commitId!, signal),
    enabled: statsEnabled,
    // Commit contents are immutable by SHA. Keep inspected commits hot so
    // reopening them never repeats an IPC call or a Git diff.
    staleTime: Infinity,
    gcTime: 30 * 60 * 1_000,
  });

  const files = statsQuery.data ?? filesQuery.data ?? [];
  const statsLoading = statsEnabled && statsQuery.isPending;
  const queriesSettled = !filesQuery.isPending && !statsLoading;
  const error = files.length === 0 && queriesSettled ? filesQuery.error ?? statsQuery.error : null;

  return {
    files,
    loading: files.length === 0 && filesQuery.isPending,
    statsLoading,
    statsReady: statsQuery.data !== undefined,
    error: error ? String(error) : null,
  };
}
