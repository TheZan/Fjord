import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import { addRemote as addRemoteCommand, listRemotes } from "@/infrastructure/tauriClient";
import type { RemoteInfo } from "@/domain/workspace";

export interface UseRemotesResult {
  remotes: RemoteInfo[];
  loading: boolean;
  error: string | null;
  addRemote: (name: string, url: string) => Promise<RemoteInfo>;
}

/** Minimal v0.1 remote connection surface: read configured remotes and add one. */
export function useRemotes(repoId: string): UseRemotesResult {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.repos.remotes(repoId);
  const query = useQuery({
    queryKey,
    queryFn: () => listRemotes(repoId),
  });
  const addMutation = useMutation({
    mutationFn: ({ name, url }: { name: string; url: string }) =>
      addRemoteCommand(repoId, name, url),
    onSuccess: (remote) => {
      queryClient.setQueryData<RemoteInfo[]>(queryKey, (current = []) =>
        [...current.filter((item) => item.name !== remote.name), remote]
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    },
  });

  return {
    remotes: query.data ?? [],
    loading: query.isPending,
    error: query.error ? userErrorMessage(query.error) : null,
    addRemote: (name, url) => addMutation.mutateAsync({ name, url }),
  };
}
