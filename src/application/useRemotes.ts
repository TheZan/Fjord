import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { userErrorMessage } from "@/application/errorMessage";
import { queryKeys } from "@/application/queryKeys";
import {
  addRemote as addRemoteCommand,
  listRemotes,
  preflightRemoveRemote as preflightRemoveRemoteCommand,
  removeRemote as removeRemoteCommand,
  renameRemote as renameRemoteCommand,
  setRemoteUrl,
} from "@/infrastructure/tauriClient";
import type { RemoteInfo, RemoveRemotePreflight } from "@/domain/workspace";

const EMPTY_REMOTES: RemoteInfo[] = [];

export interface UseRemotesResult {
  remotes: RemoteInfo[];
  loading: boolean;
  error: string | null;
  addRemote: (name: string, url: string) => Promise<RemoteInfo>;
  editRemote: (name: string, fetchUrl: string, pushUrl: string | null) => Promise<RemoteInfo>;
  renameRemote: (oldName: string, newName: string) => Promise<RemoteInfo>;
  preflightRemoveRemote: (name: string) => Promise<RemoveRemotePreflight>;
  removeRemote: (preflight: RemoveRemotePreflight) => Promise<void>;
}

function sortedRemotes(remotes: RemoteInfo[]): RemoteInfo[] {
  return remotes.sort((left, right) => left.name.localeCompare(right.name));
}

/** One shared owner for configured-remote query state and local config mutations. */
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
        sortedRemotes([...current.filter((item) => item.name !== remote.name), remote]),
      );
    },
  });
  const editMutation = useMutation({
    mutationFn: ({ name, fetchUrl, pushUrl }: { name: string; fetchUrl: string; pushUrl: string | null }) =>
      setRemoteUrl(repoId, name, fetchUrl, pushUrl),
    onSuccess: async (remote) => {
      queryClient.setQueryData<RemoteInfo[]>(queryKey, (current = []) =>
        sortedRemotes([...current.filter((item) => item.name !== remote.name), remote]),
      );
      await invalidateRemoteDependents(queryClient, repoId, false);
    },
  });
  const renameMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      renameRemoteCommand(repoId, oldName, newName),
    onSuccess: async (remote, { oldName }) => {
      queryClient.setQueryData<RemoteInfo[]>(queryKey, (current = []) =>
        sortedRemotes([
          ...current.filter((item) => item.name !== oldName && item.name !== remote.name),
          remote,
        ]),
      );
      await invalidateRemoteDependents(queryClient, repoId, true);
    },
  });
  const preflightRemoveMutation = useMutation({
    mutationFn: (name: string) => preflightRemoveRemoteCommand(repoId, name),
  });
  const removeMutation = useMutation({
    mutationFn: (preflight: RemoveRemotePreflight) =>
      removeRemoteCommand(
        repoId,
        preflight.remote,
        preflight.configGeneration,
        preflight.confirmationToken,
      ),
    onSuccess: async (_result, preflight) => {
      queryClient.setQueryData<RemoteInfo[]>(queryKey, (current = []) =>
        current.filter((item) => item.name !== preflight.remote),
      );
      await invalidateRemoteDependents(queryClient, repoId, true);
    },
  });

  return {
    remotes: query.data ?? EMPTY_REMOTES,
    loading: query.isPending,
    error: query.error ? userErrorMessage(query.error) : null,
    addRemote: (name, url) => addMutation.mutateAsync({ name, url }),
    editRemote: (name, fetchUrl, pushUrl) =>
      editMutation.mutateAsync({ name, fetchUrl, pushUrl }),
    renameRemote: (oldName, newName) => renameMutation.mutateAsync({ oldName, newName }),
    preflightRemoveRemote: (name) => preflightRemoveMutation.mutateAsync(name),
    removeRemote: (preflight) => removeMutation.mutateAsync(preflight),
  };
}

async function invalidateRemoteDependents(
  queryClient: QueryClient,
  repoId: string,
  refsChanged: boolean,
) {
  const keys: QueryKey[] = [queryKeys.repos.branches(repoId), queryKeys.repos.status(repoId)];
  if (refsChanged) {
    keys.push(queryKeys.repos.commits(repoId), queryKeys.repos.commitSearches(repoId));
  }
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
