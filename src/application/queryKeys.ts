export const queryKeys = {
  workspaces: {
    all: ["workspaces"] as const,
    list: () => [...queryKeys.workspaces.all, "list"] as const,
    repositories: (workspaceId: string) =>
      [...queryKeys.workspaces.all, workspaceId, "repositories"] as const,
    status: (workspaceId: string) => [...queryKeys.workspaces.all, workspaceId, "status"] as const,
  },
  repos: {
    all: ["repos"] as const,
    detail: (repoId: string) => [...queryKeys.repos.all, repoId] as const,
    branches: (repoId: string) => [...queryKeys.repos.detail(repoId), "branches"] as const,
    tags: (repoId: string) => [...queryKeys.repos.detail(repoId), "tags"] as const,
    status: (repoId: string) => [...queryKeys.repos.detail(repoId), "status"] as const,
    commits: (repoId: string) => [...queryKeys.repos.detail(repoId), "commits"] as const,
    commitDiff: (repoId: string, commitId: string) =>
      [...queryKeys.repos.detail(repoId), "commitDiff", commitId] as const,
    fileDiff: (repoId: string, path: string, sourceKey: string) =>
      [...queryKeys.repos.detail(repoId), "fileDiff", sourceKey, path] as const,
    workingChanges: (repoId: string) => [...queryKeys.repos.detail(repoId), "workingChanges"] as const,
    stashes: (repoId: string) => [...queryKeys.repos.detail(repoId), "stashes"] as const,
  },
};
