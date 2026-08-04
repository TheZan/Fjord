// Orchestrates the P1-01 "open a repository" flow: pick a folder, make sure
// there's a workspace to put it in (Phase 1 has no workspace-management UI
// yet — see docs/plan.md P1-01 — so the first repo silently creates one
// default workspace rather than blocking on UI that doesn't exist yet),
// persist, refresh. This is exactly the kind of orchestration `application/`
// is for (SDD §6.1); it does not belong in a presentation component.

import { useCallback, useEffect, useState } from "react";
import { pickFolder } from "@/infrastructure/dialog";
import {
  addRepository,
  createWorkspace,
  listRepositories,
  listWorkspaces,
} from "@/infrastructure/tauriClient";
import type { RepositoryEntry, Workspace } from "@/domain/workspace";

const DEFAULT_WORKSPACE_NAME = "My repositories";

// `ensureDefaultWorkspace` is check-then-act (list, then maybe create) —
// not atomic. Two overlapping callers (e.g. React 19 StrictMode's
// intentional double-invoke of this hook's effect in dev) can both see an
// empty list and both create a workspace. Caching the *in-flight promise*
// at module scope, not just the eventual result, is what closes that
// window — every caller during the same tick awaits the one real request.
let defaultWorkspacePromise: Promise<Workspace> | null = null;

function ensureDefaultWorkspace(): Promise<Workspace> {
  if (!defaultWorkspacePromise) {
    defaultWorkspacePromise = listWorkspaces().then((existing) =>
      existing.length > 0 ? existing[0] : createWorkspace(DEFAULT_WORKSPACE_NAME),
    );
  }
  return defaultWorkspacePromise;
}

export interface UseRepositoriesResult {
  repositories: RepositoryEntry[];
  loading: boolean;
  error: string | null;
  openRepository: () => Promise<void>;
}

export function useRepositories(): UseRepositoriesResult {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [repositories, setRepositories] = useState<RepositoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ensureDefaultWorkspace()
      .then(async (ws) => {
        setWorkspace(ws);
        setRepositories(await listRepositories(ws.id));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const openRepository = useCallback(async () => {
    const path = await pickFolder();
    if (!path) return;

    const ws = workspace ?? (await ensureDefaultWorkspace());
    if (!workspace) setWorkspace(ws);

    setError(null);
    try {
      await addRepository(ws.id, path);
      setRepositories(await listRepositories(ws.id));
    } catch (e) {
      setError(String(e));
    }
  }, [workspace]);

  return { repositories, loading, error, openRepository };
}
