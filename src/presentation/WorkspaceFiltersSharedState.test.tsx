import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useOverviewFilters } from "@/application/useOverviewFilters";
import { OverviewView } from "@/presentation/OverviewView";
import { AllReposView } from "@/presentation/AllReposView";
import type { RepoHealth, RepositoryEntry, Workspace } from "@/domain/workspace";

const saveOverviewFilters = vi.fn();
vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: vi.fn(async () => ({
    version: 1,
    sidebar: { width: null, collapsedWorkspaces: [] },
    repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
    selection: { workspaceId: null, repositoryId: null },
    overview: { filters: [] },
  })),
  saveOverviewFilters: (...args: unknown[]) => saveOverviewFilters(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) => {
      if (key === "dashboard.repoCountValue") return `${values?.count ?? 0} repositories`;
      const labels: Record<string, string> = {
        "filters.label": "Repository filters",
        "filters.attention": "Needs attention",
        "filters.dirty": "Dirty",
        "filters.ahead": "Ahead",
        "filters.behind": "Behind",
        "filters.conflicts": "Conflicts",
        "filters.wrongBranch": "Wrong branch",
        "filters.clear": "Clear",
      };
      return labels[key] ?? key;
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

vi.mock("@/presentation/RepoCard", () => ({
  RepoCard: ({ repo }: { repo: RepositoryEntry }) => <div data-testid={`card-${repo.id}`}>{repo.name}</div>,
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace",
  sortOrder: 0,
  expectedBranch: "develop",
};
const repositories: RepositoryEntry[] = [
  { id: "wrong", workspaceId: workspace.id, name: "Wrong", path: "/wrong", sortOrder: 0 },
  { id: "clean", workspaceId: workspace.id, name: "Clean", path: "/clean", sortOrder: 1 },
];
const healthByRepo: Record<string, RepoHealth> = {
  wrong: {
    repoId: "wrong",
    conditions: [{ kind: "wrongBranch", expected: "develop", actual: null }],
    needsAttention: true,
    asOf: "1970-01-01T00:00:00Z",
  },
  clean: {
    repoId: "clean",
    conditions: [{ kind: "clean" }],
    needsAttention: false,
    asOf: "1970-01-01T00:00:00Z",
  },
};

function Harness() {
  const [view, setView] = useState<"overview" | "all">("overview");
  const { filters, toggleFilter, clearFilters } = useOverviewFilters();
  return (
    <>
      <button type="button" onClick={() => setView("overview")}>Show Overview</button>
      <button type="button" onClick={() => setView("all")}>Show All</button>
      {view === "overview" ? (
        <OverviewView
          workspace={workspace}
          repositories={repositories}
          statusByRepo={{}}
          healthByRepo={healthByRepo}
          selectedRepoId={null}
          metrics={{ total: 2, attention: 1, behind: 0 }}
          bulkPending={null}
          bulkProgress={null}
          onCancelBulk={vi.fn()}
          onBulk={vi.fn()}
          onAddRepository={vi.fn()}
          onSelectRepo={vi.fn()}
          onWarmRepo={vi.fn()}
          onRemoveRepo={vi.fn()}
          activeFilters={filters}
          onToggleFilter={toggleFilter}
          onClearFilters={clearFilters}
          utilities={<div />}
        />
      ) : (
        <AllReposView
          rows={repositories.map((repo) => ({ workspace, repo }))}
          statusByRepo={{}}
          healthByRepo={healthByRepo}
          selectedRepoId={null}
          filter=""
          onFilterChange={vi.fn()}
          activeFilters={filters}
          onToggleFilter={toggleFilter}
          onClearFilters={clearFilters}
          onSelect={vi.fn()}
          utilities={<div />}
        />
      )}
    </>
  );
}

describe("shared workspace filter state", () => {
  beforeEach(() => {
    saveOverviewFilters.mockReset().mockResolvedValue(undefined);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(700);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shares Wrong branch between Overview and All Repositories in one session", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Wrong branch" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Wrong branch" }));
    expect(screen.getByTestId("card-wrong")).toBeInTheDocument();
    expect(screen.queryByTestId("card-clean")).not.toBeInTheDocument();
    expect(saveOverviewFilters).toHaveBeenLastCalledWith(["wrongBranch"]);

    fireEvent.click(screen.getByRole("button", { name: "Show All" }));
    expect(screen.getByRole("button", { name: "Wrong branch" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 repositories")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Wrong branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Overview" }));
    expect(screen.getByRole("button", { name: "Wrong branch" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("card-wrong")).toBeInTheDocument();
    expect(screen.getByTestId("card-clean")).toBeInTheDocument();
    expect(saveOverviewFilters).toHaveBeenLastCalledWith([]);
  });
});
