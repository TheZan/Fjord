import { useQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import type { StashFiles, StashId } from "@/domain/git";
import { getStashFiles } from "@/infrastructure/tauriClient";

const EMPTY_STASH_FILES: StashFiles = {
  staged: [],
  worktree: [],
  untracked: [],
  truncated: false,
};

export function useStashFiles(repoId: string | null, stashId: StashId | null) {
  const query = useQuery({
    queryKey: repoId && stashId ? queryKeys.repos.stashFiles(repoId, stashId) : queryKeys.repos.all,
    queryFn: ({ signal }) => getStashFiles(repoId!, stashId!, signal),
    enabled: repoId !== null && stashId !== null,
  });

  return {
    files: query.data ?? EMPTY_STASH_FILES,
    loading: query.isFetching,
    error: query.error ? userErrorMessage(query.error) : null,
  };
}
