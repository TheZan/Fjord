import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { getFileDiff, getWorkingFileDiff, invokeErrorMessage } from "@/infrastructure/tauriClient";
import type { FileDiffDetail } from "@/domain/git";

/**
 * Which side of history a diff is being read from. Uncommitted work has no
 * commit id to key off, so the two cases can't share one signature.
 */
export type DiffSource =
  | { kind: "commit"; commitId: string }
  | { kind: "working"; staged: boolean };

export interface UseFileDiffResult {
  diff: FileDiffDetail | null;
  loading: boolean;
  error: string | null;
}

/** Line-level diff for `path`, from either a commit or the working directory. */
export function useFileDiff(
  repoId: string | null,
  path: string | null,
  source: DiffSource | null,
): UseFileDiffResult {
  // Depending on the object directly would refetch on every render, since
  // callers build the source inline.
  const sourceKey = source
    ? source.kind === "commit"
      ? `commit:${source.commitId}`
      : `working:${source.staged}`
    : null;

  const query = useQuery({
    queryKey:
      repoId && path && sourceKey ? queryKeys.repos.fileDiff(repoId, path, sourceKey) : queryKeys.repos.all,
    queryFn: ({ signal }) =>
      source!.kind === "commit"
        ? getFileDiff(repoId!, source!.commitId, path!, signal)
        : getWorkingFileDiff(repoId!, path!, source!.staged, signal),
    enabled: repoId !== null && path !== null && source !== null,
    staleTime: source?.kind === "commit" ? Infinity : 0,
    gcTime: source?.kind === "commit" ? 30 * 60 * 1_000 : undefined,
  });

  return {
    diff: query.data ?? null,
    loading: query.isFetching,
    error: query.error ? invokeErrorMessage(query.error) : null,
  };
}
