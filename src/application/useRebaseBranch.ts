import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import type { MergeSource } from "@/domain/git";
import { getRebasePreflight, invokeErrorCode } from "@/infrastructure/tauriClient";

export function useRebaseBranch(repoId: string, onto: MergeSource) {
  const query = useQuery({
    queryKey: queryKeys.repos.rebasePreflight(repoId, onto.refName),
    queryFn: ({ signal }) => getRebasePreflight(repoId, onto, signal),
    staleTime: 0,
  });
  return {
    preflight: query.data ?? null,
    loading: query.isFetching || query.isPending,
    errorCode: query.error ? invokeErrorCode(query.error) : null,
    error: query.error,
  };
}
