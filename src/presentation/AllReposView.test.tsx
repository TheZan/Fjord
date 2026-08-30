import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { AllReposView } from "@/presentation/AllReposView";
import type { RepoHealth, RepositoryEntry, Workspace } from "@/domain/workspace";

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
    getTotalSize: () => count * 58,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, size: 58, start: index * 58 })),
  }),
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "Product",
  sortOrder: 0,
  expectedBranch: "develop",
};

function repository(id: string, name: string): RepositoryEntry {
  return { id, workspaceId: workspace.id, name, path: `/dev/${id}`, sortOrder: 0 };
}

function health(repoId: string, conditions: RepoHealth["conditions"], needsAttention = false): RepoHealth {
  return { repoId, conditions, needsAttention, asOf: "1970-01-01T00:00:00Z" };
}

const repositories = [
  repository("fjord", "Fjord"),
  repository("api", "BackendApi"),
  repository("docs", "FjordDocs"),
];
const healthByRepo = {
  fjord: health("fjord", [{ kind: "dirty", count: 1 }]),
  api: health("api", [{ kind: "conflict" }], true),
  docs: health("docs", [{ kind: "wrongBranch", expected: "develop", actual: null }], true),
};

function props(
  overrides: Partial<React.ComponentProps<typeof AllReposView>> = {},
): React.ComponentProps<typeof AllReposView> {
  return {
    rows: repositories.map((repo) => ({ workspace, repo })),
    statusByRepo: {},
    healthByRepo,
    selectedRepoId: null,
    filter: "",
    onFilterChange: vi.fn(),
    activeFilters: new Set(),
    onToggleFilter: vi.fn(),
    onClearFilters: vi.fn(),
    onSelect: vi.fn(),
    utilities: <div data-testid="shell-utilities" />,
    ...overrides,
  };
}

describe("AllReposView", () => {
  it("passes an automated accessibility scan", async () => {
    const { container } = render(<AllReposView {...props({ rows: [] })} />);
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });

  it("renders all six keyboard-accessible filter chips with aria-pressed", () => {
    const onToggleFilter = vi.fn();
    const { rerender } = render(<AllReposView {...props({ onToggleFilter })} />);
    const group = screen.getByRole("group", { name: "Repository filters" });
    for (const label of ["Needs attention", "Dirty", "Ahead", "Behind", "Conflicts", "Wrong branch"]) {
      expect(within(group).getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
    }

    fireEvent.click(within(group).getByRole("button", { name: "Dirty" }));
    expect(onToggleFilter).toHaveBeenCalledWith("dirty");
    rerender(<AllReposView {...props({ activeFilters: new Set(["dirty"]), onToggleFilter })} />);
    expect(screen.getByRole("button", { name: "Dirty" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Dirty" }));
    expect(onToggleFilter).toHaveBeenLastCalledWith("dirty");
  });

  it("composes Dirty and Wrong branch with OR", () => {
    render(<AllReposView {...props({ activeFilters: new Set(["dirty", "wrongBranch"]) })} />);

    expect(screen.getByRole("button", { name: /^Fjord \/dev\/fjord Product/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^FjordDocs \/dev\/docs Product/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /BackendApi.*Product/ })).not.toBeInTheDocument();
    expect(screen.getByText("2 repositories")).toBeInTheDocument();
  });

  it("composes text query with health filters using AND", () => {
    render(<AllReposView {...props({ filter: "fjord", activeFilters: new Set(["dirty"]) })} />);

    expect(screen.getByRole("button", { name: /^Fjord \/dev\/fjord Product/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /FjordDocs.*Product/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /BackendApi.*Product/ })).not.toBeInTheDocument();
  });

  it("distinguishes no repositories from no matches and Clear leaves text unchanged", () => {
    const onFilterChange = vi.fn();
    const onClearFilters = vi.fn();
    const { rerender } = render(
      <AllReposView {...props({ rows: [], onFilterChange, onClearFilters })} />,
    );
    expect(screen.getByText("allRepositories.empty")).toBeInTheDocument();

    rerender(
      <AllReposView
        {...props({ filter: "missing", activeFilters: new Set(["ahead"]), onFilterChange, onClearFilters })}
      />,
    );
    expect(screen.getByText("filters.noMatches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
    expect(onFilterChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("allRepositories.filterPlaceholder")).toHaveValue("missing");
  });

  it("accepts text filter input changes", () => {
    const onFilterChange = vi.fn();
    render(<AllReposView {...props({ onFilterChange })} />);
    fireEvent.change(screen.getByPlaceholderText("allRepositories.filterPlaceholder"), {
      target: { value: "api" },
    });
    expect(onFilterChange).toHaveBeenCalledWith("api");
  });

  it("filters a synthetic ws-100 fixture to Wrong branch including detached health", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      workspace,
      repo: repository(`repo-${index}`, `Repository ${index}`),
    }));
    const fixtureHealth = Object.fromEntries(
      rows.map(({ repo }, index) => [
        repo.id,
        index % 20 === 0
          ? health(repo.id, [{ kind: "wrongBranch", expected: "develop", actual: index === 0 ? null : "feature/x" }], true)
          : health(repo.id, [{ kind: "clean" }]),
      ]),
    );

    render(
      <AllReposView
        {...props({ rows, healthByRepo: fixtureHealth, activeFilters: new Set(["wrongBranch"]) })}
      />,
    );

    expect(screen.getByText("5 repositories")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Repository \d+.*Product/ })).toHaveLength(5);
    expect(screen.getByRole("button", { name: /Repository 0.*Product/ })).toBeInTheDocument();
  });
});
