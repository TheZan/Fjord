import { useCallback, useEffect, useState } from "react";
import { getCommitLog } from "@/infrastructure/tauriClient";
import type { CommitSummary } from "@/domain/git";

const PAGE_SIZE = 30;

export interface UseCommitLogResult {
  commits: CommitSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
}

/** Paginated commit history for `repoId`, resetting whenever it changes. */
export function useCommitLog(repoId: string | null): UseCommitLogResult {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    (targetRepoId: string, afterCursor: string | null, replace: boolean, cancelledRef: { current: boolean }) => {
      setLoading(true);
      setError(null);

      getCommitLog(targetRepoId, afterCursor, PAGE_SIZE)
        .then((page) => {
          if (cancelledRef.current) return;
          setCommits((prev) => (replace ? page.commits : [...prev, ...page.commits]));
          setCursor(page.nextCursor);
        })
        .catch((e) => {
          if (!cancelledRef.current) setError(String(e));
        })
        .finally(() => {
          if (!cancelledRef.current) setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    setCommits([]);
    setCursor(null);
    if (!repoId) return;

    const cancelledRef = { current: false };
    fetchPage(repoId, null, true, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [repoId, fetchPage]);

  const loadMore = useCallback(() => {
    if (!repoId || !cursor || loading) return;
    fetchPage(repoId, cursor, false, { current: false });
  }, [repoId, cursor, loading, fetchPage]);

  return { commits, loading, error, hasMore: cursor !== null, loadMore };
}
