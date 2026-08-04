import { useEffect, useState } from "react";
import { getFileDiff } from "@/infrastructure/tauriClient";
import type { FileDiffDetail } from "@/domain/git";

export interface UseFileDiffResult {
  diff: FileDiffDetail | null;
  loading: boolean;
  error: string | null;
}

/** Line-level diff for `path` at `commitId` in `repoId`, refetching whenever any of them changes. */
export function useFileDiff(repoId: string | null, commitId: string | null, path: string | null): UseFileDiffResult {
  const [diff, setDiff] = useState<FileDiffDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId || !commitId || !path) {
      setDiff(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff(null);

    getFileDiff(repoId, commitId, path)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, commitId, path]);

  return { diff, loading, error };
}
