import { useEffect, useState } from "react";
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
  const [diff, setDiff] = useState<FileDiffDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Depending on the object directly would refetch on every render, since
  // callers build the source inline.
  const sourceKey = source
    ? source.kind === "commit"
      ? `commit:${source.commitId}`
      : `working:${source.staged}`
    : null;

  useEffect(() => {
    if (!repoId || !path || !source) {
      setDiff(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff(null);

    const request =
      source.kind === "commit"
        ? getFileDiff(repoId, source.commitId, path)
        : getWorkingFileDiff(repoId, path, source.staged);

    request
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((e) => {
        if (!cancelled) setError(invokeErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, path, sourceKey]);

  return { diff, loading, error };
}
