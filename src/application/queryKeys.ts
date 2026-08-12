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
    commitSearches: (repoId: string) => [...queryKeys.repos.detail(repoId), "commitSearch"] as const,
    commitSearch: (repoId: string, query: string) =>
      [...queryKeys.repos.commitSearches(repoId), query] as const,
    commitDiffs: (repoId: string) => [...queryKeys.repos.detail(repoId), "commitDiff"] as const,
    commitFiles: (repoId: string, commitId: string) =>
      [...queryKeys.repos.commitDiffs(repoId), commitId, "files"] as const,
    commitDiff: (repoId: string, commitId: string) =>
      [...queryKeys.repos.commitDiffs(repoId), commitId, "stats"] as const,
    fileDiffs: (repoId: string) => [...queryKeys.repos.detail(repoId), "fileDiff"] as const,
    fileDiff: (repoId: string, path: string, sourceKey: string) =>
      [...queryKeys.repos.fileDiffs(repoId), sourceKey, path] as const,
    fileDiffAuthorities: (repoId: string) =>
      [...queryKeys.repos.detail(repoId), "fileDiffAuthority"] as const,
    fileDiffAuthority: (repoId: string, path: string, sourceKey: string) =>
      [...queryKeys.repos.fileDiffAuthorities(repoId), sourceKey, path] as const,
    workingChanges: (repoId: string) => [...queryKeys.repos.detail(repoId), "workingChanges"] as const,
    stashes: (repoId: string) => [...queryKeys.repos.detail(repoId), "stashes"] as const,
  },
};
