import { useQuery } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import type { MergePreflight, MergeSource } from "@/domain/git";
import { getMergePreflight, invokeErrorCode } from "@/infrastructure/tauriClient";

export interface UseMergeBranchResult {
  preflight: MergePreflight | null;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
}

/** One generation-aware preflight shared by every merge entry point. */
export function useMergeBranch(
  repoId: string,
  source: MergeSource | null,
): UseMergeBranchResult {
  const query = useQuery({
    queryKey: source
      ? queryKeys.repos.mergePreflight(repoId, source.refName)
      : [...queryKeys.repos.detail(repoId), "mergePreflight", "closed"],
    queryFn: ({ signal }) => getMergePreflight(repoId, source!, signal),
    enabled: source !== null,
  });

  return {
    preflight: query.data ?? null,
    loading: source !== null && query.isPending,
    error: query.error ? userErrorMessage(query.error) : null,
    errorCode: query.error ? invokeErrorCode(query.error) : null,
  };
}
