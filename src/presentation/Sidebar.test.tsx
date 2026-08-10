import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/presentation/Sidebar";
import type { RepoStatusSummary, RepositoryEntry, Workspace } from "@/domain/workspace";

const loadUiState = vi.fn();
const saveCollapsedWorkspaces = vi.fn();

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: (...args: unknown[]) => loadUiState(...args),
  saveCollapsedWorkspaces: (...args: unknown[]) => saveCollapsedWorkspaces(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      key === "cardStatus.changes" ? `${values?.count} changes` : key,
  }),
}));

const workspaces: Workspace[] = [
  { id: "one", name: "One", sortOrder: 0 },
  { id: "two", name: "Two", sortOrder: 1 },
];
const repo: RepositoryEntry = {
  id: "repo-1",
  workspaceId: "one",
  name: "Fjord",
  path: "/dev/fjord",
  sortOrder: 0,
};
const status: RepoStatusSummary = {
  repoId: "repo-1",
  status: { branch: "main", ahead: 1, behind: 2, dirtyCount: 3, hasConflict: false },
  lastSyncedAt: null,
};

function props(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return {
    view: "overview" as const,
    onViewChange: vi.fn(),
    workspaces,
    repositoriesByWorkspace: { one: [repo], two: [] },
    statusByRepo: { "repo-1": status },
    repoCountByWorkspace: { one: 1, two: 0 },
    attentionByWorkspace: { one: 1, two: 0 },
    selectedWorkspaceId: "one",
    selectedRepoId: null,
    onSelectWorkspace: vi.fn(),
    onSelectRepository: vi.fn(),
    onWarmRepository: vi.fn(),
    onCreateWorkspace: vi.fn(),
    onRenameWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onMoveWorkspace: vi.fn(),
    onMoveWorkspaceTo: vi.fn(),
    pending: null,
    ...overrides,
  };
}

describe("Sidebar", () => {
  beforeEach(() => {
    loadUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    });
    saveCollapsedWorkspaces.mockResolvedValue(undefined);
  });

  it("starts with navigation and renders no shell branding", () => {
    const { container } = render(<Sidebar {...props({ selectedWorkspaceId: null })} />);
    const sidebar = container.querySelector("aside")!;

    expect(sidebar.querySelector("button")).toHaveTextContent("nav.overview");
    expect(screen.queryByLabelText("Fjord")).not.toBeInTheDocument();
    expect(screen.queryByText("app.title")).not.toBeInTheDocument();
  });

  it("auto-expands the selected workspace and wires repository selection and warm-up", async () => {
    const sidebarProps = props();
    render(<Sidebar {...sidebarProps} />);
    const repoButton = await screen.findByRole("button", { name: /Fjord/ });

    expect(repoButton).toHaveTextContent("main");
    expect(repoButton).toHaveTextContent("3 changes");
    fireEvent.pointerEnter(repoButton);
    fireEvent.focus(repoButton);
    fireEvent.click(repoButton);

    expect(sidebarProps.onWarmRepository).toHaveBeenCalledTimes(2);
    expect(sidebarProps.onWarmRepository).toHaveBeenCalledWith("repo-1");
    expect(sidebarProps.onSelectRepository).toHaveBeenCalledWith("one", "repo-1");

    fireEvent.click(screen.getAllByRole("button", { name: "workspaces.collapse" })[0]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Fjord/ })).not.toBeInTheDocument());
    expect(saveCollapsedWorkspaces).toHaveBeenCalledWith(["one"]);
  });

  it("reorders a dragged workspace by the drop target and ignores a self-drop", () => {
    const sidebarProps = props({ selectedWorkspaceId: null });
    render(<Sidebar {...sidebarProps} />);
    const source = screen.getByRole("button", { name: /One/ }).closest('[draggable="true"]')!;
    const target = screen.getByRole("button", { name: /Two/ }).closest('[draggable="true"]')!;
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => "one"),
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "one");
    expect(sidebarProps.onMoveWorkspaceTo).toHaveBeenCalledWith("one", "two");

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(source, { dataTransfer });
    expect(sidebarProps.onMoveWorkspaceTo).toHaveBeenCalledTimes(1);
  });
});
