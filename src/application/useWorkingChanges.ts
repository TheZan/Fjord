import { useEffect, useState } from "react";
import { getWorkingChanges, invokeErrorMessage } from "@/infrastructure/tauriClient";
import type { WorkingChanges } from "@/domain/git";

export interface UseWorkingChangesResult {
  changes: WorkingChanges;
  loading: boolean;
  error: string | null;
}

const EMPTY: WorkingChanges = { staged: [], unstaged: [] };

/**
 * Uncommitted work for `repoId`. Shares the `version` counter with
 * `useRepoStatus`, so staging, unstaging and committing all refresh the list
 * through the same bump the rest of the detail view already does.
 */
export function useWorkingChanges(repoId: string | null, version: number): UseWorkingChangesResult {
  const [changes, setChanges] = useState<WorkingChanges>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) {
      setChanges(EMPTY);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getWorkingChanges(repoId)
      .then((result) => {
        if (!cancelled) setChanges(result);
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
  }, [repoId, version]);

  return { changes, loading, error };
}
