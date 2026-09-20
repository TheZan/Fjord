import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import type { MergeSource } from "@/domain/git";
import { getRebaseTodo, invokeErrorCode } from "@/infrastructure/tauriClient";

export function useInteractiveRebase(repoId: string, onto: MergeSource) {
  const query = useQuery({
    queryKey: queryKeys.repos.rebaseTodo(repoId, onto.refName),
    queryFn: ({ signal }) => getRebaseTodo(repoId, onto, signal),
    staleTime: 0,
  });
  return {
    todo: query.data ?? null,
    loading: query.isFetching || query.isPending,
    errorCode: query.error ? invokeErrorCode(query.error) : null,
    error: query.error,
  };
}
