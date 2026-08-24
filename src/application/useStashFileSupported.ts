import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { stashFileSupported } from "@/infrastructure/tauriClient";

/** Whether the resolved Git executable supports pathspec-limited
 * `stash push -- <path>` (Git >= 2.13). Not repository-scoped: it depends
 * only on the resolved Git executable, which is shared app-wide. */
export function useStashFileSupported(): boolean {
  const query = useQuery({
    queryKey: queryKeys.git.stashFileSupported,
    queryFn: () => stashFileSupported(),
    staleTime: Infinity,
  });
  return query.data ?? true;
}
