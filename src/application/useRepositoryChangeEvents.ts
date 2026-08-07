import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateRepoData, type RepoDataScope } from "@/application/invalidateRepoData";
import { queryKeys } from "@/application/queryKeys";
import type { RepoStatusSummary, RepositoryEntry } from "@/domain/workspace";
import {
  listenRepositoryChanges,
  type RepositoryChangedEvent,
} from "@/infrastructure/tauriClient";

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
  const repositoriesByIdRef = useRef(new Map<string, RepositoryEntry>());

  useEffect(() => {
    repositoriesByIdRef.current = new Map(repositories.map((repo) => [repo.id, repo]));
  }, [repositories]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenRepositoryChanges((event) => {
      const repo = repositoriesByIdRef.current.get(event.repoId);
      if (!repo) return;

      const statusSummary = event.statusSummary;
      if (statusSummary) {
        queryClient.setQueryData(queryKeys.repos.status(repo.id), statusSummary.status);
        queryClient.setQueryData<RepoStatusSummary[]>(
          queryKeys.workspaces.status(repo.workspaceId),
          (current) => replaceStatusSummary(current, statusSummary),
        );
      }

      const requested = repositoryChangeScopes(event).filter(
        (scope) => scope !== "status" || !statusSummary,
      );
      if (requested.length > 0) {
        void invalidateRepoData(queryClient, repo.id, repo.workspaceId, requested);
      }
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);
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
