import { useCallback, useEffect, useMemo, useState } from "react";
import { pickFolder } from "@/infrastructure/dialog";
import {
  addRepository as addRepositoryCommand,
  createWorkspace as createWorkspaceCommand,
  deleteWorkspace as deleteWorkspaceCommand,
  listRepositories,
  listWorkspaces,
  removeRepository as removeRepositoryCommand,
  renameWorkspace as renameWorkspaceCommand,
  reorderWorkspaces,
} from "@/infrastructure/tauriClient";
import type { RepositoryEntry, Workspace } from "@/domain/workspace";

function sortWorkspaces(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder);
}

function withLocalOrder(workspaces: Workspace[]): Workspace[] {
  return workspaces.map((workspace, index) => ({ ...workspace, sortOrder: index }));
}

export interface UseRepositoriesResult {
  workspaces: Workspace[];
  selectedWorkspace: Workspace | null;
  selectedWorkspaceId: string | null;
  repositories: RepositoryEntry[];
  loading: boolean;
  error: string | null;
  workspaceActionPending: string | null;
  selectWorkspace: (id: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  moveWorkspace: (id: string, direction: -1 | 1) => Promise<void>;
  openRepository: () => Promise<void>;
  removeRepository: (id: string) => Promise<void>;
}

export function useRepositories(): UseRepositoriesResult {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<RepositoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceActionPending, setWorkspaceActionPending] = useState<string | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const loadRepositories = useCallback(async (workspaceId: string) => {
    setRepositories(await listRepositories(workspaceId));
  }, []);

  useEffect(() => {
    let cancelled = false;

    listWorkspaces()
      .then(async (loaded) => {
        const ordered = sortWorkspaces(loaded);
        const nextSelectedId = ordered[0]?.id ?? null;
        const loadedRepositories = nextSelectedId ? await listRepositories(nextSelectedId) : [];
        if (cancelled) return;

        setWorkspaces(ordered);
        setSelectedWorkspaceId(nextSelectedId);
        setRepositories(loadedRepositories);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectWorkspace = useCallback(
    async (id: string) => {
      setError(null);
      setSelectedWorkspaceId(id);
      await loadRepositories(id);
    },
    [loadRepositories],
  );

  const createWorkspace = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setError(null);
    setWorkspaceActionPending("create");
    try {
      const created = await createWorkspaceCommand(trimmed);
      setWorkspaces((current) => sortWorkspaces([...current, created]));
      setSelectedWorkspaceId(created.id);
      setRepositories(await listRepositories(created.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setWorkspaceActionPending(null);
    }
  }, []);

  const renameWorkspace = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setError(null);
    setWorkspaceActionPending(id);
    try {
      const renamed = await renameWorkspaceCommand(id, trimmed);
      setWorkspaces((current) =>
        sortWorkspaces(current.map((workspace) => (workspace.id === id ? renamed : workspace))),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setWorkspaceActionPending(null);
    }
  }, []);

  const deleteWorkspace = useCallback(
    async (id: string) => {
      setError(null);
      setWorkspaceActionPending(id);
      try {
        await deleteWorkspaceCommand(id);
        const remaining = workspaces.filter((workspace) => workspace.id !== id);
        const nextSelectedId =
          id === selectedWorkspaceId ? remaining[0]?.id ?? null : selectedWorkspaceId;

        setWorkspaces(remaining);
        setSelectedWorkspaceId(nextSelectedId);
        setRepositories(nextSelectedId ? await listRepositories(nextSelectedId) : []);
      } catch (e) {
        setError(String(e));
      } finally {
        setWorkspaceActionPending(null);
      }
    },
    [selectedWorkspaceId, workspaces],
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

      setError(null);
      setWorkspaceActionPending(id);
      try {
        await reorderWorkspaces(locallyOrdered.map((workspace) => workspace.id));
        setWorkspaces(locallyOrdered);
      } catch (e) {
        setError(String(e));
      } finally {
        setWorkspaceActionPending(null);
      }
    },
    [workspaces],
  );

  const openRepository = useCallback(async () => {
    if (!selectedWorkspaceId) return;

    const path = await pickFolder();
    if (!path) return;

    setError(null);
    try {
      await addRepositoryCommand(selectedWorkspaceId, path);
      await loadRepositories(selectedWorkspaceId);
    } catch (e) {
      setError(String(e));
    }
  }, [loadRepositories, selectedWorkspaceId]);

  const removeRepository = useCallback(
    async (id: string) => {
      if (!selectedWorkspaceId) return;

      setError(null);
      try {
        await removeRepositoryCommand(id);
        await loadRepositories(selectedWorkspaceId);
      } catch (e) {
        setError(String(e));
      }
    },
    [loadRepositories, selectedWorkspaceId],
  );

  return {
    workspaces,
    selectedWorkspace,
    selectedWorkspaceId,
    repositories,
    loading,
    error,
    workspaceActionPending,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveWorkspace,
    openRepository,
    removeRepository,
  };
}
