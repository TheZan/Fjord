import { useEffect, useState } from "react";
import { getStashes, invokeErrorMessage } from "@/infrastructure/tauriClient";
import type { StashEntry } from "@/domain/git";

export interface UseStashesResult {
  stashes: StashEntry[];
  loading: boolean;
  error: string | null;
}

/**
 * Stash stack for `repoId`. Takes the same `version` counter as
 * `useRepoStatus` so pushing or popping a stash refetches without the caller
 * having to remount the toolbar.
 */
export function useStashes(repoId: string | null, version: number): UseStashesResult {
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) {
      setStashes([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getStashes(repoId)
      .then((result) => {
        if (!cancelled) setStashes(result);
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

  return { stashes, loading, error };
}
