import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { diffToolAvailability } from "@/infrastructure/tauriClient";

/** Whether `Settings.diff_tool` (or Git's own `diff.tool`) currently
 * resolves to something Git can run — read live per repository, since it
 * depends on Git configuration Fjord does not otherwise track. */
export function useDiffToolAvailability(repoId: string, ready = true): boolean {
  const query = useQuery({
    queryKey: queryKeys.repos.diffToolAvailability(repoId),
    queryFn: () => diffToolAvailability(repoId),
    enabled: ready,
  });
  return query.data ?? false;
}
