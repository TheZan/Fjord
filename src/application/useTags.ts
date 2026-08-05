import { useEffect, useState } from "react";
import { getTags } from "@/infrastructure/tauriClient";
import type { TagInfo } from "@/domain/git";

export interface UseTagsResult {
  tags: TagInfo[];
  loading: boolean;
  error: string | null;
}

/** Fetches tags for `repoId`, refetching whenever it changes. `null` means no repo selected. */
export function useTags(repoId: string | null): UseTagsResult {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) {
      setTags([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    getTags(repoId)
      .then((result) => {
        if (!cancelled) setTags(result);
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

  return { tags, loading, error };
}
