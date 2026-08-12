import { useCallback, useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import {
  acceptWorkingDiffSnapshot,
  beginWorkingDiffFetch,
  useWorkingDiffSnapshotRejected,
  workingDiffSourceKey,
} from "@/application/diffSnapshotAuthority";
import {
  getFileDiffPage,
  getWorkingFileDiffPage,
  observeDiffPage,
  type VersionedFileDiffWindow,
} from "@/infrastructure/tauriClient";
import type { DiffHunk, FileDiffWindow, GenerationSet } from "@/domain/git";

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
  generations: GenerationSet | null;
  snapshotInvalid: boolean;
};

export const DIFF_WINDOW_LINES = 1_000;

export interface DiffWindowPage extends VersionedFileDiffWindow {
  requestedOffset: number;
  repoId: string;
  requestedPath: string;
  sourceKey: string;
  fetchSequence: number;
}

export type DiffWindowMergeResult =
  | { status: "empty" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; diff: FileDiffWindow; generations: GenerationSet };

/** Fetches bounded line windows and merges them without duplicating a hunk header. */
export function useFileDiff(
  repoId: string | null,
  path: string | null,
  source: DiffSource | null,
): UseFileDiffResult {
  const queryClient = useQueryClient();
  const rejectedData = useRef<unknown>(null);
  const sourceKey = source
    ? source.kind === "commit"
      ? `commit:${source.commitId}`
      : workingDiffSourceKey(source.staged ? "index" : "worktree")
    : null;

  const queryKey = useMemo(
    () => repoId && path && sourceKey
      ? queryKeys.repos.fileDiff(repoId, path, sourceKey)
      : queryKeys.repos.all,
    [path, repoId, sourceKey],
  );
  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }): Promise<DiffWindowPage> => {
      const fetchSequence = source!.kind === "working"
        ? beginWorkingDiffFetch(queryClient, repoId!, path!, sourceKey!)
        : 0;
      const response = source!.kind === "commit"
        ? await getFileDiffPage(
            repoId!,
            source!.commitId,
            path!,
            pageParam,
            DIFF_WINDOW_LINES,
            signal,
          )
        : await getWorkingFileDiffPage(
            repoId!,
            path!,
            source!.staged,
            pageParam,
            DIFF_WINDOW_LINES,
            signal,
          );
      return {
        ...response,
        requestedOffset: pageParam,
        repoId: repoId!,
        requestedPath: path!,
        sourceKey: sourceKey!,
        fetchSequence,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.data.nextOffset ?? undefined,
    enabled: repoId !== null && path !== null && source !== null,
    staleTime: source?.kind === "commit" ? Infinity : 0,
    gcTime: source?.kind === "commit" ? 30 * 60 * 1_000 : undefined,
  });

  const merge = useMemo(
    () => validateAndMergeDiffWindows(query.data?.pages ?? []),
    [query.data?.pages],
  );
  const snapshotMismatch = merge.status === "invalid";
  const snapshotInvalid = useWorkingDiffSnapshotRejected(repoId, path, sourceKey);

  useEffect(() => {
    if (!snapshotMismatch || !query.data || rejectedData.current === query.data) return;
    rejectedData.current = query.data;
    void queryClient.resetQueries({ queryKey, exact: true });
  }, [query.data, queryClient, queryKey, snapshotMismatch]);

  useEffect(() => {
    if (!snapshotMismatch) rejectedData.current = null;
  }, [snapshotMismatch]);

  useEffect(() => {
    if (merge.status !== "valid" || !repoId) return;
    observeDiffPage(repoId, { data: merge.diff, generations: merge.generations }, source?.kind === "working" ? "working" : "history");
  }, [merge, repoId, source?.kind]);

  useEffect(() => {
    if (source?.kind !== "working" || merge.status !== "valid" || !query.data || !sourceKey) return;
    const successfulFetchSequence = Math.min(...query.data.pages.map((page) => page.fetchSequence));
    acceptWorkingDiffSnapshot(queryClient, repoId!, path!, sourceKey, successfulFetchSequence);
  }, [merge, path, query.data, queryClient, repoId, source?.kind, sourceKey]);

  const loadMore = useCallback(() => {
    if (!snapshotMismatch && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query, snapshotMismatch]);

  return {
    diff: merge.status === "valid" ? merge.diff : null,
    loading: query.isPending || snapshotMismatch,
    loadingMore: !snapshotMismatch && query.isFetchingNextPage,
    hasMore: !snapshotMismatch && query.hasNextPage,
    loadMore,
    error: query.error ? userErrorMessage(query.error) : null,
    generations: merge.status === "valid" ? merge.generations : null,
    snapshotInvalid,
  };
}

export function mergeDiffWindows(pages: DiffWindowPage[]): FileDiffWindow | null {
  const result = validateAndMergeDiffWindows(pages);
  return result.status === "valid" ? result.diff : null;
}

export function validateAndMergeDiffWindows(pages: DiffWindowPage[]): DiffWindowMergeResult {
  const firstPage = pages[0];
  if (!firstPage) return { status: "empty" };
  if (firstPage.requestedOffset !== 0) return invalid("the first window does not start at offset zero");
  if (!firstPage.generations) return invalid("the first window has no generation stamp");

  const first = firstPage.data;
  const hunks: DiffHunk[] = [];
  let expectedOffset = 0;
  let complete = false;

  for (const [pageIndex, page] of pages.entries()) {
    const window = page.data;
    if (complete) return invalid("a window follows a page that claimed completeness");
    if (page.repoId !== firstPage.repoId) return invalid("repository identity changed between windows");
    if (page.requestedPath !== firstPage.requestedPath || window.path !== page.requestedPath) {
      return invalid("path identity changed between windows");
    }
    if (page.sourceKey !== firstPage.sourceKey) return invalid("diff source changed between windows");
    if (!page.generations || !sameGenerations(page.generations, firstPage.generations)) {
      return invalid("repository generations changed between windows");
    }
    if (!sameSnapshotMetadata(window, first)) return invalid("diff snapshot metadata changed between windows");
    if (page.requestedOffset !== expectedOffset) return invalid("diff window offsets are not contiguous");
    if (window.offset !== page.requestedOffset) return invalid("the backend served a different diff offset than requested");

    const lineCount = window.hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
    const endOffset = page.requestedOffset + lineCount;
    if (endOffset > window.totalLines) return invalid("a diff window exceeds its declared total line count");
    if (window.hunks.length > window.totalHunks) return invalid("a diff window exceeds its declared total hunk count");

    const contentFree = window.isBinary || window.tooLarge;
    if (contentFree && (page.requestedOffset !== 0 || window.hunks.length !== 0)) {
      return invalid("a content-free diff response contains windowed lines");
    }

    if (window.truncated) {
      if (contentFree) return invalid("a content-free diff response claims continuation");
      if (window.nextOffset === null || window.nextOffset !== endOffset || endOffset >= window.totalLines) {
        return invalid("a truncated diff window has a broken continuation cursor");
      }
      if (lineCount === 0) return invalid("a truncated diff window made no cursor progress");
      expectedOffset = window.nextOffset;
    } else {
      if (window.nextOffset !== null || (!contentFree && endOffset !== window.totalLines)) {
        return invalid("a complete diff window does not end at the declared total");
      }
      if (pageIndex !== pages.length - 1) return invalid("a complete diff window is not last");
      complete = true;
    }

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
        if (previous && previous.oldStart === hunk.oldStart && previous.newStart === hunk.newStart) {
          return invalid("a split hunk changed structural coordinates");
        }
        if (hunks.some((seen) => sameHunkIdentity(seen, hunk))) {
          return invalid("a diff hunk was repeated out of order");
        }
        hunks.push({ ...hunk, lines: [...hunk.lines] });
      }
    }
  }

  if (hunks.length > first.totalHunks || (complete && hunks.length !== first.totalHunks)) {
    return invalid("merged hunk count does not match the declared total");
  }

  const last = pages.at(-1)!.data;
  return { status: "valid", generations: firstPage.generations, diff: {
    ...first,
    hunks,
    truncated: last.truncated,
    nextOffset: last.nextOffset,
  } };
}

function invalid(reason: string): DiffWindowMergeResult {
  return { status: "invalid", reason };
}

function sameSnapshotMetadata(window: FileDiffWindow, first: FileDiffWindow) {
  return window.path === first.path
    && window.changeType === first.changeType
    && window.oldMode === first.oldMode
    && window.newMode === first.newMode
    && window.isBinary === first.isBinary
    && window.tooLarge === first.tooLarge
    && window.fileBytes === first.fileBytes
    && window.totalHunks === first.totalHunks
    && window.totalLines === first.totalLines
    && window.baseDigest === first.baseDigest;
}

function sameGenerations(left: GenerationSet, right: GenerationSet) {
  return left.workingTree === right.workingTree
    && left.refs === right.refs
    && left.history === right.history
    && left.stash === right.stash
    && left.config === right.config;
}

function sameHunkIdentity(left: DiffHunk, right: DiffHunk) {
  return left.oldStart === right.oldStart
    && left.oldLines === right.oldLines
    && left.newStart === right.newStart
    && left.newLines === right.newLines;
}
