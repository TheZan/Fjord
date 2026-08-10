import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import type {
  CommitPage,
  SnapshotRevalidation,
  StoredRepositorySnapshot,
} from "@/domain/generated";
import {
  captureRepositorySnapshotInBackground,
  getRepositorySnapshot,
  revalidateRepositorySnapshot,
} from "@/infrastructure/tauriClient";
import { observeRepositoryGenerations } from "@/infrastructure/repositoryGenerations";

export interface RepositorySnapshotState {
  ready: boolean;
  validated: boolean;
  capturedAt: string | null;
  ensureValidated: () => Promise<boolean>;
  revalidate: () => Promise<boolean>;
}

type SnapshotViewState = Omit<RepositorySnapshotState, "ensureValidated" | "revalidate">;

const INITIAL_STATE: SnapshotViewState = {
  ready: false,
  validated: false,
  capturedAt: null,
};

/**
 * Hydrates every primary repository query before the view mounts, then patches
 * those same cache entries with a live snapshot. Persisted generations are
 * deliberately observed only after that live revalidation succeeds.
 */
export function useRepositorySnapshot(repoId: string): RepositorySnapshotState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SnapshotViewState>(INITIAL_STATE);
  const lifecycle = useRef(0);
  const activeRevalidation = useRef<Promise<boolean> | null>(null);

  const hydrate = useCallback(
    (stored: StoredRepositorySnapshot, observeGenerations: boolean) => {
      const snapshot = stored.snapshot;
      queryClient.setQueryData(queryKeys.repos.status(repoId), snapshot.status);
      queryClient.setQueryData(queryKeys.repos.branches(repoId), snapshot.branches);
      queryClient.setQueryData(queryKeys.repos.tags(repoId), snapshot.tags);
      queryClient.setQueryData<InfiniteData<CommitPage, string | null>>(
        queryKeys.repos.commits(repoId),
        { pages: [snapshot.firstHistoryPage], pageParams: [null] },
      );
      queryClient.setQueryData(queryKeys.repos.workingChanges(repoId), snapshot.workingChanges);

      if (observeGenerations) {
        for (const scope of ["status", "working", "history", "refs"] as const) {
          observeRepositoryGenerations(repoId, snapshot.generations, scope);
        }
      }
    },
    [queryClient, repoId],
  );

  const validate = useCallback((): Promise<boolean> => {
    if (activeRevalidation.current) return activeRevalidation.current;
    const expectedLifecycle = lifecycle.current;
    const request = revalidateRepositorySnapshot(repoId)
      .then((result: SnapshotRevalidation) => {
        if (lifecycle.current !== expectedLifecycle) return false;
        hydrate(result.snapshot, true);
        setState({ ready: true, validated: true, capturedAt: result.snapshot.capturedAt });
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (activeRevalidation.current === request) activeRevalidation.current = null;
      });
    activeRevalidation.current = request;
    return request;
  }, [hydrate, repoId]);

  useEffect(() => {
    lifecycle.current += 1;
    const expectedLifecycle = lifecycle.current;
    activeRevalidation.current = null;
    setState(INITIAL_STATE);
    let cancelScheduledValidation: (() => void) | null = null;

    void getRepositorySnapshot(repoId)
      .then((stored) => {
        if (lifecycle.current !== expectedLifecycle) return;
        if (stored) {
          hydrate(stored, false);
          setState({ ready: true, validated: false, capturedAt: stored.capturedAt });
          // Let the snapshot commit and paint close the switching interaction
          // before live Git work begins. Validation is deliberately the next
          // frame's background work, not part of SLO-4.
          cancelScheduledValidation = scheduleAfterPaint(() => void validate());
        } else {
          // There is no stale decision input: mount the normal live queries
          // immediately while the all-in-one capture proceeds in parallel.
          setState({ ready: true, validated: true, capturedAt: null });
        }
      })
      .catch(() => {
        if (lifecycle.current !== expectedLifecycle) return;
        // Snapshot persistence is an optional cache. Its failure must never
        // prevent the ordinary live-query path from opening a repository.
        setState({ ready: true, validated: true, capturedAt: null });
      });

    return () => {
      lifecycle.current += 1;
      activeRevalidation.current = null;
      cancelScheduledValidation?.();
      void captureRepositorySnapshotInBackground(repoId).catch(() => undefined);
    };
  }, [hydrate, repoId, validate]);

  const ensureValidated = useCallback(
    () => (state.validated ? Promise.resolve(true) : validate()),
    [state.validated, validate],
  );

  return { ...state, ensureValidated, revalidate: validate };
}

function scheduleAfterPaint(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(callback);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }

  const timer = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timer);
}
