import { useEffect, useState } from "react";
import { getBranches } from "@/infrastructure/tauriClient";
import type { BranchInfo } from "@/domain/git";

export interface UseBranchesResult {
  branches: BranchInfo[];
  loading: boolean;
  error: string | null;
}

/** Fetches branches for `repoId`, refetching whenever it changes. `null` means no repo selected. */
export function useBranches(repoId: string | null): UseBranchesResult {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) {
      setBranches([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    getBranches(repoId)
      .then((result) => {
        if (!cancelled) setBranches(result);
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
  }, [repoId]);

  return { branches, loading, error };
}
