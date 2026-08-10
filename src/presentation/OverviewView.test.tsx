import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewView } from "@/presentation/OverviewView";
import type { RepositoryEntry, Workspace } from "@/domain/workspace";

const virtualization = vi.hoisted(() => ({ count: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) => {
      if (key === "dashboard.repoCountValue") return `${values?.count} repositories`;
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
    expect(screen.getByText("dashboard.needAttention").parentElement).toHaveTextContent("2");
    expect(screen.getByText("dashboard.behindOrigin").parentElement).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "bulk.fetch" }));
    expect(overviewProps.onBulk).toHaveBeenCalledWith("fetch");
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(container.querySelector('[style*="width: 50%"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "operations.cancel" }));
    expect(overviewProps.onCancelBulk).toHaveBeenCalledOnce();
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

  it("disables workspace actions when no workspace is selected", () => {
    render(<OverviewView {...props({ workspace: null })} />);

    expect(screen.getByRole("button", { name: "bulk.fetch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "repositories.openButton" })).toBeDisabled();
    expect(screen.getByText("repositories.empty")).toBeInTheDocument();
  });
});
