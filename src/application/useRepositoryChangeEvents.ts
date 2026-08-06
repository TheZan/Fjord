import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateRepoData, type RepoDataScope } from "@/application/invalidateRepoData";
import { queryKeys } from "@/application/queryKeys";
import type { RepoStatusSummary, RepositoryEntry } from "@/domain/workspace";
import {
  listenRepositoryChanges,
  type RepositoryChangedEvent,
} from "@/infrastructure/tauriClient";

const UI_EVENT_DEBOUNCE_MS = 80;

export function repositoryChangeScopes(event: RepositoryChangedEvent): RepoDataScope[] {
  const scopes: RepoDataScope[] = [];
  if (event.status) scopes.push("status");
  if (event.working) scopes.push("working");
  if (event.history) scopes.push("history");
  if (event.refs) scopes.push("refs");
  if (event.stashes) scopes.push("stashes");
  return scopes;
}

/**
 * Bridges debounced native repository events into React Query. Inactive
 * queries are only marked stale; React Query refetches them when their view
 * opens, so background repositories do not create Git work in the UI.
 */
export function useRepositoryChangeEvents(repositories: RepositoryEntry[]) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const repositoriesById = new Map(repositories.map((repo) => [repo.id, repo]));
    const pendingScopes = new Map<string, Set<RepoDataScope>>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenRepositoryChanges((event) => {
      const repo = repositoriesById.get(event.repoId);
      if (!repo) return;

      const statusSummary = event.statusSummary;
      if (statusSummary) {
        queryClient.setQueryData(queryKeys.repos.status(repo.id), statusSummary.status);
        queryClient.setQueryData<RepoStatusSummary[]>(
          queryKeys.workspaces.status(repo.workspaceId),
          (current) => replaceStatusSummary(current, statusSummary),
        );
      }

      const scopes = pendingScopes.get(repo.id) ?? new Set<RepoDataScope>();
      for (const scope of repositoryChangeScopes(event)) {
        if (scope !== "status" || !statusSummary) scopes.add(scope);
      }
      pendingScopes.set(repo.id, scopes);

      const existingTimer = timers.get(repo.id);
      if (existingTimer) clearTimeout(existingTimer);
      timers.set(
        repo.id,
        setTimeout(() => {
          timers.delete(repo.id);
          const requested = [...(pendingScopes.get(repo.id) ?? [])];
          pendingScopes.delete(repo.id);
          if (requested.length > 0) {
            void invalidateRepoData(queryClient, repo.id, repo.workspaceId, requested);
          }
        }, UI_EVENT_DEBOUNCE_MS),
      );
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });

    return () => {
      disposed = true;
      unlisten?.();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [queryClient, repositories]);
}

function replaceStatusSummary(
  current: RepoStatusSummary[] | undefined,
  next: RepoStatusSummary,
) {
  if (!current) return current;
  const index = current.findIndex((summary) => summary.repoId === next.repoId);
  if (index < 0) return [...current, next];
  const updated = [...current];
  updated[index] = next;
  return updated;
}
