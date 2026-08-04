import { useEffect, useState } from "react";
import { getRepoStatus, invokeErrorMessage } from "@/infrastructure/tauriClient";
import type { RepoStatus } from "@/domain/git";

export interface UseRepoStatusResult {
  status: RepoStatus | null;
  loading: boolean;
  error: string | null;
}

export function useRepoStatus(repoId: string | null, version: number): UseRepoStatusResult {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getRepoStatus(repoId)
      .then((result) => {
        if (!cancelled) setStatus(result);
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

  return { status, loading, error };
}
