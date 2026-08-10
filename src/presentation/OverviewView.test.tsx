import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { OverviewView } from "@/presentation/OverviewView";
import type { RepositoryEntry, Workspace } from "@/domain/workspace";

const virtualization = vi.hoisted(() => ({ count: 0 }));
const loadUiState = vi.fn();
const saveOverviewFilters = vi.fn();

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: (...args: unknown[]) => loadUiState(...args),
  saveOverviewFilters: (...args: unknown[]) => saveOverviewFilters(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) => {
      if (key === "dashboard.repoCountValue") return `${values?.count} repositories`;
      if (key === "dashboard.needAttentionValue") return `${values?.count} need attention`;
      if (key === "dashboard.behindOriginValue") return `${values?.count} behind`;
      if (key === "operations.progress") return `${values?.completed}/${values?.total}`;
      return key;
    },
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    virtualization.count = count;
    const visible = Array.from(new Set([0, Math.min(1, count - 1)])).filter((index) => index >= 0);
    return {
      getTotalSize: () => count * 124,
      getVirtualItems: () => visible.map((index) => ({ index, key: index, size: 112, start: index * 124 })),
    };
  },
}));

vi.mock("@/presentation/RepoCard", () => ({
  RepoCard: ({ repo, onSelect, onWarm, onRemove }: {
    repo: RepositoryEntry;
    onSelect: () => void;
    onWarm: () => void;
    onRemove: () => void;
  }) => (
    <div data-testid={`card-${repo.id}`}>
      <button type="button" onClick={onSelect} onPointerEnter={onWarm}>{repo.name}</button>
      <button type="button" aria-label={`remove-${repo.id}`} onClick={onRemove}>remove</button>
    </div>
  ),
}));

const workspace: Workspace = { id: "workspace-1", name: "Workspace", sortOrder: 0 };

function repository(index: number): RepositoryEntry {
  return {
    id: `repo-${index}`,
    workspaceId: workspace.id,
    name: `Repository ${index}`,
    path: `/dev/repo-${index}`,
    sortOrder: index,
  };
}

function props(overrides: Partial<React.ComponentProps<typeof OverviewView>> = {}) {
  return {
    workspace,
    repositories: [],
    statusByRepo: {},
    selectedRepoId: null,
    metrics: { total: 5, attention: 2, behind: 1 },
    bulkPending: null,
    bulkProgress: null,
    onCancelBulk: vi.fn(),
    onBulk: vi.fn(),
    onOpenRepository: vi.fn(),
    onImport: vi.fn(),
    onSelectRepo: vi.fn(),
    onWarmRepo: vi.fn(),
    onRemoveRepo: vi.fn(),
    importPending: false,
    ...overrides,
  };
}

describe("OverviewView", () => {
  beforeEach(() => {
    loadUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    });
    saveOverviewFilters.mockResolvedValue(undefined);
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

  it("reports metrics, dispatches bulk work, and exposes cancellable progress", () => {
    const overviewProps = props({
      bulkProgress: { completed: 1, total: 2, error: null, status: "fetching" },
    });
    const { container } = render(<OverviewView {...overviewProps} />);

    expect(screen.getByText("5 repositories")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 need attention" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 behind" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "bulk.fetch" }));
    expect(overviewProps.onBulk).toHaveBeenCalledWith("fetch");
    fireEvent.click(screen.getByRole("button", { name: "toolbar.moreActions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "bulk.openIde" }));
    expect(overviewProps.onBulk).toHaveBeenCalledWith("open-ide");
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(container.querySelector('[style*="width: 50%"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "operations.cancel" }));
    expect(overviewProps.onCancelBulk).toHaveBeenCalledOnce();
  });

  it("passes an automated accessibility scan", async () => {
    const { container } = render(<OverviewView {...props()} />);
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });

  it("limits the header to four controls and keeps secondary actions in overflow", () => {
    const overviewProps = props();
    const { container } = render(<OverviewView {...overviewProps} />);
    const header = container.querySelector("header")!;

    expect(within(header).getAllByRole("button")).toHaveLength(4);
    expect(within(header).getByRole("button", { name: "bulk.fetch" })).toBeVisible();
    expect(within(header).getByRole("button", { name: "bulk.pull" })).toBeVisible();
    expect(within(header).getByRole("button", { name: "repositories.addButton" })).toBeVisible();

    fireEvent.click(within(header).getByRole("button", { name: "toolbar.moreActions" }));
    expect(screen.getByRole("menuitem", { name: "bulk.openIde" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "repositories.importButton" }));
    expect(overviewProps.onImport).toHaveBeenCalledOnce();
  });

  it("groups repositories into measured columns and renders only virtual rows", () => {
    const repositories = Array.from({ length: 5 }, (_, index) => repository(index + 1));
    const overviewProps = props({ repositories });
    render(<OverviewView {...overviewProps} />);

    expect(virtualization.count).toBe(3);
    expect(screen.getByTestId("card-repo-1")).toBeInTheDocument();
    expect(screen.getByTestId("card-repo-4")).toBeInTheDocument();
    expect(screen.queryByTestId("card-repo-5")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Repository 1" }));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Repository 2" }));
    fireEvent.click(screen.getByRole("button", { name: "remove-repo-3" }));
    expect(overviewProps.onSelectRepo).toHaveBeenCalledWith("repo-1");
    expect(overviewProps.onWarmRepo).toHaveBeenCalledWith("repo-2");
    expect(overviewProps.onRemoveRepo).toHaveBeenCalledWith("repo-3");
  });

  it("omits zero summary segments and filters repositories from non-zero segments", () => {
    const repositories = [repository(1), repository(2), repository(3)];
    const statusByRepo = {
      "repo-1": {
        repoId: "repo-1",
        status: { branch: "main", ahead: 0, behind: 0, dirtyCount: 1, hasConflict: false },
        lastSyncedAt: null,
      },
      "repo-2": {
        repoId: "repo-2",
        status: { branch: "main", ahead: 0, behind: 1, dirtyCount: 0, hasConflict: false },
        lastSyncedAt: null,
      },
      "repo-3": {
        repoId: "repo-3",
        status: { branch: "main", ahead: 0, behind: 0, dirtyCount: 0, hasConflict: false },
        lastSyncedAt: null,
      },
    };
    const { rerender } = render(
      <OverviewView
        {...props({ repositories, statusByRepo, metrics: { total: 3, attention: 2, behind: 1 } })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2 need attention" }));
    expect(saveOverviewFilters).toHaveBeenCalledWith(["attention"]);
    expect(screen.getByTestId("card-repo-1")).toBeInTheDocument();
    expect(screen.getByTestId("card-repo-2")).toBeInTheDocument();
    expect(screen.queryByTestId("card-repo-3")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2 need attention" }));
    fireEvent.click(screen.getByRole("button", { name: "1 behind" }));
    expect(screen.queryByTestId("card-repo-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("card-repo-2")).toBeInTheDocument();

    rerender(
      <OverviewView
        {...props({ repositories, statusByRepo, metrics: { total: 3, attention: 0, behind: 0 } })}
      />,
    );
    expect(screen.queryByRole("button", { name: /need attention/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /behind/ })).not.toBeInTheDocument();
  });

  it("restores active overview filters", async () => {
    loadUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: ["behind"] },
    });
    const repositories = [repository(1), repository(2)];
    const statusByRepo = {
      "repo-1": {
        repoId: "repo-1",
        status: { branch: "main", ahead: 0, behind: 0, dirtyCount: 0, hasConflict: false },
        lastSyncedAt: null,
      },
      "repo-2": {
        repoId: "repo-2",
        status: { branch: "main", ahead: 0, behind: 1, dirtyCount: 0, hasConflict: false },
        lastSyncedAt: null,
      },
    };

    render(
      <OverviewView
        {...props({ repositories, statusByRepo, metrics: { total: 2, attention: 1, behind: 1 } })}
      />,
    );

    await waitFor(() => expect(screen.queryByTestId("card-repo-1")).not.toBeInTheDocument());
    expect(screen.getByTestId("card-repo-2")).toBeInTheDocument();
  });

  it("disables workspace actions when no workspace is selected", () => {
    render(<OverviewView {...props({ workspace: null })} />);

    expect(screen.getByRole("button", { name: "bulk.fetch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "repositories.addButton" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "toolbar.moreActions" }));
    expect(screen.getByRole("menuitem", { name: "bulk.openIde" })).toBeDisabled();
    expect(screen.getByText("repositories.empty")).toBeInTheDocument();
  });
});
