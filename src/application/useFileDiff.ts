import { useCallback, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import { getFileDiff, getWorkingFileDiff } from "@/infrastructure/tauriClient";
import type { DiffHunk, FileDiffWindow } from "@/domain/git";

export type DiffSource =
  | { kind: "commit"; commitId: string }
  | { kind: "working"; staged: boolean };

export interface UseFileDiffResult {
  diff: FileDiffWindow | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
}

export const DIFF_WINDOW_LINES = 1_000;

/** Fetches bounded line windows and merges them without duplicating a hunk header. */
export function useFileDiff(
  repoId: string | null,
  path: string | null,
  source: DiffSource | null,
): UseFileDiffResult {
  const sourceKey = source
    ? source.kind === "commit"
      ? `commit:${source.commitId}`
      : `working:${source.staged}`
    : null;

  const query = useInfiniteQuery({
    queryKey:
      repoId && path && sourceKey
        ? queryKeys.repos.fileDiff(repoId, path, sourceKey)
        : queryKeys.repos.all,
    queryFn: ({ pageParam, signal }) =>
      source!.kind === "commit"
        ? getFileDiff(repoId!, source!.commitId, path!, pageParam, DIFF_WINDOW_LINES, signal)
        : getWorkingFileDiff(
            repoId!,
            path!,
            source!.staged,
            pageParam,
            DIFF_WINDOW_LINES,
            signal,
          ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: repoId !== null && path !== null && source !== null,
    staleTime: source?.kind === "commit" ? Infinity : 0,
    gcTime: source?.kind === "commit" ? 30 * 60 * 1_000 : undefined,
  });

  const diff = useMemo(() => mergeDiffWindows(query.data?.pages ?? []), [query.data?.pages]);
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  return {
    diff,
    loading: query.isPending,
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    loadMore,
    error: query.error ? userErrorMessage(query.error) : null,
  };
}

export function mergeDiffWindows(windows: FileDiffWindow[]): FileDiffWindow | null {
  const first = windows[0];
  if (!first) return null;
  const hunks: DiffHunk[] = [];
  for (const window of windows) {
    for (const hunk of window.hunks) {
      const previous = hunks.at(-1);
      if (
        previous &&
        previous.oldStart === hunk.oldStart &&
        previous.newStart === hunk.newStart &&
        previous.oldLines === hunk.oldLines &&
        previous.newLines === hunk.newLines
      ) {
        previous.lines.push(...hunk.lines);
      } else {
        hunks.push({ ...hunk, lines: [...hunk.lines] });
      }
    }
  }
  const last = windows.at(-1)!;
  return {
    ...first,
    hunks,
    truncated: last.truncated,
    nextOffset: last.nextOffset,
  };
}
