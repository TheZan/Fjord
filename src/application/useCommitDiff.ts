import { useEffect, useState } from "react";
import { getCommitDiff } from "@/infrastructure/tauriClient";
import type { FileDiff } from "@/domain/git";

export interface UseCommitDiffResult {
  files: FileDiff[];
  loading: boolean;
  error: string | null;
}

/** Changed-files summary for `commitId` in `repoId`, refetching whenever either changes. */
export function useCommitDiff(repoId: string | null, commitId: string | null): UseCommitDiffResult {
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId || !commitId) {
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFiles([]);

    getCommitDiff(repoId, commitId)
      .then((result) => {
        if (!cancelled) setFiles(result);
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
  }, [repoId, commitId]);

  return { files, loading, error };
}
