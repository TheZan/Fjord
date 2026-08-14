import type { RepositoryEntry, Workspace } from "@/domain/workspace";

export function resolveRestoredSelection(
  saved: { workspaceId: string | null; repositoryId: string | null },
  workspaces: Workspace[],
  repositoriesByWorkspace: Record<string, RepositoryEntry[]>,
): { workspaceId: string | null; repositoryId: string | null } {
  const fallbackWorkspaceId = workspaces[0]?.id ?? null;
  const workspaceId = workspaces.some((workspace) => workspace.id === saved.workspaceId)
    ? saved.workspaceId
    : fallbackWorkspaceId;
  if (!workspaceId) return { workspaceId: null, repositoryId: null };
  const repositoryId = (repositoriesByWorkspace[workspaceId] ?? []).some(
    (repository) => repository.id === saved.repositoryId,
  )
    ? saved.repositoryId
    : null;
  return { workspaceId, repositoryId };
}
