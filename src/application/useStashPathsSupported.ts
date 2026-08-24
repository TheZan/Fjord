import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { stashPathsSupported } from "@/infrastructure/tauriClient";

/** Whether the resolved Git executable supports exact scoped stash creation.
 * This is global because Fjord uses one resolved executable app-wide. */
export function useStashPathsSupported(): boolean {
  const query = useQuery({
    queryKey: queryKeys.git.stashPathsSupported,
    queryFn: () => stashPathsSupported(),
    staleTime: Infinity,
  });
  return query.data ?? true;
}
