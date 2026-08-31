import type {
  RepoHealth,
  RepoStatusSummary,
  RepositoryEntry,
  Workspace,
} from "../../src/domain/workspace";

export interface TauriWorkspaceFixture {
  workspaces: Workspace[];
  repositories: RepositoryEntry[];
  statuses: RepoStatusSummary[];
  health: RepoHealth[];
}

const workspace: Workspace = {
  id: "ws-100",
  name: "ws-100",
  sortOrder: 0,
  expectedBranch: "develop",
};

const repositories = Array.from({ length: 100 }, (_, index): RepositoryEntry => {
  const suffix = index.toString().padStart(3, "0");
  return {
    id: `repo-${suffix}`,
    workspaceId: workspace.id,
    name: `repo-${suffix}`,
    path: `/fixtures/ws-100/repo-${suffix}`,
    sortOrder: index,
  };
});

const statuses = repositories.map((repository, index): RepoStatusSummary => {
  const wrongBranch = index % 10 === 0;
  return {
    repoId: repository.id,
    status: {
      branch:
        index === 0 ? null : wrongBranch ? `feature/${repository.id}` : workspace.expectedBranch,
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      hasConflict: false,
    },
    lastSyncedAt: "2026-08-31T00:00:00Z",
  };
});

const health = repositories.map((repository, index): RepoHealth => {
  const wrongBranch = index % 10 === 0;
  return {
    repoId: repository.id,
    conditions: wrongBranch
      ? [
          {
            kind: "wrongBranch",
            expected: "develop",
            // repo-000 models detached/unborn HEAD through the production
            // backend projection contract rather than a frontend comparison.
            actual: index === 0 ? null : `feature/${repository.id}`,
          },
        ]
      : [{ kind: "clean" }],
    needsAttention: wrongBranch,
    asOf: "2026-08-31T00:00:00Z",
  };
});

export const ws100Fixture: TauriWorkspaceFixture = {
  workspaces: [workspace],
  repositories,
  statuses,
  health,
};
