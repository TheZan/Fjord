import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repoIsBehind, repoNeedsAttention } from "@/application/repoHealth";
import type { RepoHealth, RepoStatusSummary, RepositoryEntry, Workspace } from "@/domain/workspace";
import { OverviewView } from "@/presentation/OverviewView";
import { Sidebar } from "@/presentation/Sidebar";

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: vi.fn(async () => ({
    version: 1,
    sidebar: { width: null, collapsedWorkspaces: [] },
    repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
    selection: { workspaceId: null, repositoryId: null },
    overview: { filters: [] },
  })),
  saveCollapsedWorkspaces: vi.fn(async () => undefined),
  saveOverviewFilters: vi.fn(async () => undefined),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) => {
      if (key === "dashboard.repoCountValue") return `${values?.count} repositories`;
      if (key === "dashboard.needAttentionValue") return `${values?.count} need attention`;
      if (key === "dashboard.behindOriginValue") return `${values?.count} behind`;
      if (key === "cardStatus.changes") return `${values?.count} changes`;
      return key;
    },
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 124,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, size: 112, start: index * 124 })),
  }),
}));

const workspace: Workspace = { id: "workspace-1", name: "Workspace", sortOrder: 0 };
const repo: RepositoryEntry = {
  id: "repo-1",
  workspaceId: workspace.id,
  name: "Fjord",
  path: "/dev/fjord",
  sortOrder: 0,
};
const status: RepoStatusSummary = {
  repoId: repo.id,
  status: { branch: "develop", ahead: 2, behind: 3, dirtyCount: 4, hasConflict: false },
  lastSyncedAt: "1970-01-01T00:00:00Z",
};

function Surfaces({ health }: { health: RepoHealth }) {
  const healthByRepo = { [repo.id]: health };
  const attention = Number(repoNeedsAttention(health));
  const behind = Number(repoIsBehind(health));

  return (
    <>
      <Sidebar
        view="overview"
        onViewChange={vi.fn()}
        workspaces={[workspace]}
        repositoriesByWorkspace={{ [workspace.id]: [repo] }}
        statusByRepo={{ [repo.id]: status }}
        healthByRepo={healthByRepo}
        repoCountByWorkspace={{ [workspace.id]: 1 }}
        attentionByWorkspace={{ [workspace.id]: attention }}
        selectedWorkspaceId={workspace.id}
        selectedRepoId={null}
        onSelectWorkspace={vi.fn()}
        onSelectRepository={vi.fn()}
        onWarmRepository={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onRenameWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onMoveWorkspace={vi.fn()}
        onMoveWorkspaceTo={vi.fn()}
        pending={null}
      />
      <OverviewView
        workspace={workspace}
        repositories={[repo]}
        statusByRepo={{ [repo.id]: status }}
        healthByRepo={healthByRepo}
        selectedRepoId={null}
        metrics={{ total: 1, attention, behind }}
        bulkPending={null}
        bulkProgress={null}
        onCancelBulk={vi.fn()}
        onBulk={vi.fn()}
        onAddRepository={vi.fn()}
        onSelectRepo={vi.fn()}
        onWarmRepo={vi.fn()}
        onRemoveRepo={vi.fn()}
        utilities={<div />}
      />
    </>
  );
}

describe("workspace health surfaces", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(700);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps dashboard attention, sidebar badge, and attention filtering on one health value", async () => {
    const dirty: RepoHealth = {
      repoId: repo.id,
      conditions: [{ kind: "dirty", count: 4 }],
      needsAttention: false,
      asOf: "1970-01-01T00:00:00Z",
    };
    const diverged: RepoHealth = {
      repoId: repo.id,
      conditions: [{ kind: "diverged", ahead: 2, behind: 3 }, { kind: "dirty", count: 4 }],
      needsAttention: true,
      asOf: "1970-01-01T00:00:00Z",
    };

    const { container, rerender } = render(<Surfaces health={dirty} />);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-health-condition="dirty"]')).toHaveLength(2),
    );
    expect(screen.queryByRole("button", { name: "1 need attention" })).not.toBeInTheDocument();
    expect(container.querySelector('[data-health-condition="dirty"]')).toHaveAttribute(
      "data-needs-attention",
      "false",
    );

    rerender(<Surfaces health={diverged} />);
    const attentionFilter = screen.getByRole("button", { name: "1 need attention" });
    expect(container.querySelectorAll('[data-health-condition="diverged"]')).toHaveLength(2);
    for (const surface of container.querySelectorAll('[data-health-condition="diverged"]')) {
      expect(surface).toHaveAttribute("data-needs-attention", "true");
    }

    fireEvent.click(attentionFilter);
    expect(container.querySelector('[data-health-condition="diverged"]')).toBeInTheDocument();
  });
});
