import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { pickFolder } from "@/infrastructure/dialog";
import {
  addRepository as addRepositoryCommand,
  createWorkspace as createWorkspaceCommand,
  deleteWorkspace as deleteWorkspaceCommand,
  getWorkspaceStatus,
  importRepositories as importRepositoriesCommand,
  invokeErrorMessage,
  listRepositories,
  listWorkspaces,
  removeRepository as removeRepositoryCommand,
  renameWorkspace as renameWorkspaceCommand,
  reorderWorkspaces,
} from "@/infrastructure/tauriClient";
import type { RepoStatusSummary, RepositoryEntry, Workspace } from "@/domain/workspace";

function sortWorkspaces(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder);
}

function withLocalOrder(workspaces: Workspace[]): Workspace[] {
  return workspaces.map((workspace, index) => ({ ...workspace, sortOrder: index }));
}

function queryError(queries: Array<{ error: Error | null }>): string | null {
  const failed = queries.find((query) => query.error);
  return failed?.error ? invokeErrorMessage(failed.error) : null;
}

export interface UseRepositoriesResult {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  selectedWorkspaceId: string | null;
  repositories: RepositoryEntry[];
  repositoriesByWorkspace: Record<string, RepositoryEntry[]>;
  statusByRepo: Record<string, RepoStatusSummary>;
  loading: boolean;
  error: string | null;
  workspaceActionPending: string | null;
  selectWorkspace: (id: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace | null>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  moveWorkspace: (id: string, direction: -1 | 1) => Promise<void>;
  openRepository: () => Promise<void>;
  importRepositories: (workspaceId?: string) => Promise<RepositoryEntry[]>;
  removeRepository: (id: string) => Promise<void>;
}

export function useRepositories(): UseRepositoriesResult {
  const queryClient = useQueryClient();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [workspaceActionPending, setWorkspaceActionPending] = useState<string | null>(null);

  const workspacesQuery = useQuery({
    queryKey: queryKeys.workspaces.list(),
    queryFn: async () => sortWorkspaces(await listWorkspaces()),
  });

  const workspaces = workspacesQuery.data ?? [];

  const repositoryQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: queryKeys.workspaces.repositories(workspace.id),
      queryFn: () => listRepositories(workspace.id),
    })),
  });

  const statusQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: queryKeys.workspaces.status(workspace.id),
      queryFn: () => getWorkspaceStatus(workspace.id),
    })),
  });

  useEffect(() => {
    if (workspaces.length === 0) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (!selectedWorkspaceId || !workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(workspaces[0].id);
    }
  }, [selectedWorkspaceId, workspaces]);

  const repositoriesByWorkspace = useMemo(
    () =>
      Object.fromEntries(
        workspaces.map((workspace, index) => [workspace.id, repositoryQueries[index]?.data ?? []]),
      ),
    [repositoryQueries, workspaces],
  );

  const statusByRepo = useMemo(
    () =>
      Object.fromEntries(
        statusQueries.flatMap((query) =>
          (query.data ?? []).map((summary) => [summary.repoId, summary] as const),
        ),
      ),
    [statusQueries],
  );

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const repositories = useMemo(
    () => (selectedWorkspaceId ? repositoriesByWorkspace[selectedWorkspaceId] ?? [] : []),
    [repositoriesByWorkspace, selectedWorkspaceId],
  );

  const createWorkspaceMutation = useMutation({
    mutationFn: (name: string) => createWorkspaceCommand(name),
  });
  const renameWorkspaceMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameWorkspaceCommand(id, name),
  });
  const deleteWorkspaceMutation = useMutation({
    mutationFn: (id: string) => deleteWorkspaceCommand(id),
  });
  const reorderWorkspacesMutation = useMutation({
    mutationFn: (ids: string[]) => reorderWorkspaces(ids),
  });
  const addRepositoryMutation = useMutation({
    mutationFn: ({ workspaceId, path }: { workspaceId: string; path: string }) =>
      addRepositoryCommand(workspaceId, path),
  });
  const importRepositoriesMutation = useMutation({
    mutationFn: ({ workspaceId, root }: { workspaceId: string; root: string }) =>
      importRepositoriesCommand(workspaceId, root),
  });
  const removeRepositoryMutation = useMutation({
    mutationFn: (id: string) => removeRepositoryCommand(id),
  });

  const invalidateWorkspace = useCallback(
    async (workspaceId: string) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.repositories(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.status(workspaceId) }),
      ]);
    },
    [queryClient],
  );

  const selectWorkspace = useCallback(async (id: string) => {
    setLocalError(null);
    setSelectedWorkspaceId(id);
  }, []);

  const createWorkspace = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return null;

      setLocalError(null);
      setWorkspaceActionPending("create");
      try {
        const created = await createWorkspaceMutation.mutateAsync(trimmed);
        queryClient.setQueryData<Workspace[]>(queryKeys.workspaces.list(), (current = []) =>
          sortWorkspaces([...current, created]),
        );
        setSelectedWorkspaceId(created.id);
        await invalidateWorkspace(created.id);
        return created;
      } catch (e) {
        setLocalError(invokeErrorMessage(e));
        return null;
      } finally {
        setWorkspaceActionPending(null);
      }
    },
    [createWorkspaceMutation, invalidateWorkspace, queryClient],
  );

  const renameWorkspace = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      setLocalError(null);
      setWorkspaceActionPending(id);
      try {
        const renamed = await renameWorkspaceMutation.mutateAsync({ id, name: trimmed });
        queryClient.setQueryData<Workspace[]>(queryKeys.workspaces.list(), (current = []) =>
          sortWorkspaces(current.map((workspace) => (workspace.id === id ? renamed : workspace))),
        );
      } catch (e) {
        setLocalError(invokeErrorMessage(e));
      } finally {
        setWorkspaceActionPending(null);
      }
    },
    [queryClient, renameWorkspaceMutation],
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      setLocalError(null);
      setWorkspaceActionPending(id);
      try {
        await deleteWorkspaceMutation.mutateAsync(id);
        const remaining = workspaces.filter((workspace) => workspace.id !== id);
        const nextSelectedId =
          id === selectedWorkspaceId ? remaining[0]?.id ?? null : selectedWorkspaceId;

        queryClient.setQueryData<Workspace[]>(queryKeys.workspaces.list(), remaining);
        queryClient.removeQueries({ queryKey: queryKeys.workspaces.repositories(id) });
        queryClient.removeQueries({ queryKey: queryKeys.workspaces.status(id) });
        for (const repo of repositoriesByWorkspace[id] ?? []) {
          queryClient.removeQueries({ queryKey: queryKeys.repos.detail(repo.id) });
        }
        setSelectedWorkspaceId(nextSelectedId);
      } catch (e) {
        setLocalError(invokeErrorMessage(e));
      } finally {
        setWorkspaceActionPending(null);
      }
    },
    [
      deleteWorkspaceMutation,
      queryClient,
      repositoriesByWorkspace,
      selectedWorkspaceId,
      workspaces,
    ],
  );

  const moveWorkspace = useCallback(
    async (id: string, direction: -1 | 1) => {
      const currentIndex = workspaces.findIndex((workspace) => workspace.id === id);
      const nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= workspaces.length) return;

      const reordered = [...workspaces];
      const [moved] = reordered.splice(currentIndex, 1);
      reordered.splice(nextIndex, 0, moved);
      const locallyOrdered = withLocalOrder(reordered);

      setLocalError(null);
      setWorkspaceActionPending(id);
      try {
        await reorderWorkspacesMutation.mutateAsync(locallyOrdered.map((workspace) => workspace.id));
        queryClient.setQueryData<Workspace[]>(queryKeys.workspaces.list(), locallyOrdered);
      } catch (e) {
        setLocalError(invokeErrorMessage(e));
        await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list() });
      } finally {
        setWorkspaceActionPending(null);
      }
    },
    [queryClient, reorderWorkspacesMutation, workspaces],
  );

  const openRepository = useCallback(async () => {
    if (!selectedWorkspaceId) return;

    const path = await pickFolder();
    if (!path) return;

    setLocalError(null);
    try {
      await addRepositoryMutation.mutateAsync({ workspaceId: selectedWorkspaceId, path });
      await invalidateWorkspace(selectedWorkspaceId);
    } catch (e) {
      setLocalError(invokeErrorMessage(e));
    }
  }, [addRepositoryMutation, invalidateWorkspace, selectedWorkspaceId]);

  const importRepositories = useCallback(
    async (workspaceId = selectedWorkspaceId) => {
      if (!workspaceId) return [];

      const root = await pickFolder();
      if (!root) return [];

      setLocalError(null);
      setWorkspaceActionPending("import");
      try {
        const imported = await importRepositoriesMutation.mutateAsync({ workspaceId, root });
        await invalidateWorkspace(workspaceId);
        return imported;
      } catch (e) {
        setLocalError(invokeErrorMessage(e));
        return [];
      } finally {
        setWorkspaceActionPending(null);
      }
    },
    [importRepositoriesMutation, invalidateWorkspace, selectedWorkspaceId],
  );

  const removeRepository = useCallback(
    async (id: string) => {
      if (!selectedWorkspaceId) return;

      setLocalError(null);
      try {
        await removeRepositoryMutation.mutateAsync(id);
        queryClient.removeQueries({ queryKey: queryKeys.repos.detail(id) });
        await invalidateWorkspace(selectedWorkspaceId);
      } catch (e) {
        setLocalError(invokeErrorMessage(e));
      }
    },
    [invalidateWorkspace, queryClient, removeRepositoryMutation, selectedWorkspaceId],
  );

  const queryBackedError =
    workspacesQuery.error ? invokeErrorMessage(workspacesQuery.error) : queryError(repositoryQueries) ?? queryError(statusQueries);

  return {
    workspaces,
    selectedWorkspace,
    selectedWorkspaceId,
    repositories,
    repositoriesByWorkspace,
    statusByRepo,
    loading:
      workspacesQuery.isLoading ||
      repositoryQueries.some((query) => query.isLoading) ||
      statusQueries.some((query) => query.isLoading),
    error: localError ?? queryBackedError,
    workspaceActionPending,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveWorkspace,
    openRepository,
    importRepositories,
    removeRepository,
  };
}
