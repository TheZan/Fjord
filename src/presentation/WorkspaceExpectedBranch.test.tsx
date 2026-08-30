import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countOnExpectedBranch } from "@/application/repoHealth";
import type { RepoHealth, RepositoryEntry, RepoStatusSummary, Workspace } from "@/domain/workspace";
import { OverviewView } from "@/presentation/OverviewView";
import { WorkspaceSettingsDialog } from "@/presentation/WorkspaceSettingsDialog";

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: vi.fn(async () => ({
    version: 1,
    sidebar: { width: null, collapsedWorkspaces: [] },
    repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
    selection: { workspaceId: null, repositoryId: null },
    overview: { filters: [] },
  })),
  saveOverviewFilters: vi.fn(async () => undefined),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      if (key === "dashboard.repoCountValue") return `${values?.count} repositories`;
      if (key === "dashboard.needAttentionValue") return `${values?.count} need attention`;
      if (key === "dashboard.behindOriginValue") return `${values?.count} behind`;
      if (key === "dashboard.onExpectedBranchValue")
        return `${values?.count} of ${values?.total} on ${values?.branch}`;
      if (key === "dashboard.onExpectedBranchKnownValue")
        return `${values?.count} of ${values?.total} known on ${values?.branch}`;
      if (key === "workspaceSettings.title") return "Workspace settings";
      if (key === "workspaceSettings.expectedBranch") return "Expected branch";
      if (key === "workspaceSettings.forWorkspace") return `Settings for ${values?.workspace}.`;
      if (key === "workspaces.save") return "Save";
      if (key === "workspaces.cancel") return "Cancel";
      return key;
    },
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
  }),
}));

vi.mock("@/application/errorMessage", () => ({
  userErrorMessage: (error: unknown) =>
    `translated:${(error as { code?: string }).code ?? "unknown"}`,
}));

const workspaceId = "workspace-1";

function workspace(expectedBranch: string | null): Workspace {
  return { id: workspaceId, name: "Backend", sortOrder: 0, expectedBranch };
}

function repository(index: number): RepositoryEntry {
  return {
    id: `repo-${index}`,
    workspaceId,
    name: `repo-${index}`,
    path: `/dev/repo-${index}`,
    sortOrder: index,
  };
}

function health(repoId: string, conditions: RepoHealth["conditions"]): RepoHealth {
  return {
    repoId,
    conditions,
    needsAttention: conditions.some((condition) => condition.kind === "wrongBranch"),
    asOf: "1970-01-01T00:00:00Z",
  };
}

function renderOverview(
  repositories: RepositoryEntry[],
  healthByRepo: Record<string, RepoHealth>,
  expectedBranch: string | null,
) {
  const statusByRepo: Record<string, RepoStatusSummary> = {};
  return render(
    <OverviewView
      workspace={workspace(expectedBranch)}
      repositories={repositories}
      statusByRepo={statusByRepo}
      healthByRepo={healthByRepo}
      selectedRepoId={null}
      metrics={{ total: repositories.length, attention: 0, behind: 0 }}
      bulkPending={null}
      bulkProgress={null}
      onCancelBulk={vi.fn()}
      onBulk={vi.fn()}
      onAddRepository={vi.fn()}
      onSelectRepo={vi.fn()}
      onWarmRepo={vi.fn()}
      onRemoveRepo={vi.fn()}
      utilities={<div />}
    />,
  );
}

describe("expected-branch summary", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
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

  it("reports the count on the expected branch from backend health alone", () => {
    const repositories = Array.from({ length: 31 }, (_, index) => repository(index));
    const healthByRepo = Object.fromEntries(
      repositories.map((repo, index) => [
        repo.id,
        index < 28
          ? health(repo.id, [{ kind: "clean" }])
          : health(repo.id, [
              { kind: "wrongBranch", expected: "develop", actual: "feature/x" },
            ]),
      ]),
    );

    renderOverview(repositories, healthByRepo, "develop");

    expect(screen.getByText("28 of 31 on develop")).toBeInTheDocument();
  });

  it("counts a detached repository as off the expected branch", () => {
    const repositories = [repository(0), repository(1)];
    const healthByRepo = {
      [repositories[0].id]: health(repositories[0].id, [{ kind: "clean" }]),
      // Detached HEAD: the backend reports WrongBranch with no actual branch,
      // and must never be read as "on develop".
      [repositories[1].id]: health(repositories[1].id, [
        { kind: "wrongBranch", expected: "develop", actual: null },
      ]),
    };

    renderOverview(repositories, healthByRepo, "develop");

    expect(screen.getByText("1 of 2 on develop")).toBeInTheDocument();
  });

  it("does not count an unreadable repository as matching", () => {
    const repositories = [repository(0), repository(1), repository(2)];
    const healthByRepo = {
      [repositories[0].id]: health(repositories[0].id, [{ kind: "clean" }]),
      [repositories[1].id]: health(repositories[1].id, [{ kind: "clean" }]),
      [repositories[2].id]: health(repositories[2].id, [
        { kind: "unreadable", reasonCode: "status_unavailable" },
      ]),
    };

    renderOverview(repositories, healthByRepo, "develop");

    expect(screen.getByText("2 of 2 known on develop")).toBeInTheDocument();
  });

  it("shows no branch summary when the workspace has no expected branch", () => {
    const repositories = [repository(0)];
    const healthByRepo = {
      [repositories[0].id]: health(repositories[0].id, [
        { kind: "wrongBranch", expected: "develop", actual: "feature/x" },
      ]),
    };

    renderOverview(repositories, healthByRepo, null);

    expect(screen.queryByText(/on develop/)).not.toBeInTheDocument();
  });

  it("classifies from the health projection, not from a raw branch comparison", () => {
    const repositories = [repository(0), repository(1), repository(2)];
    const healthByRepo = {
      [repositories[0].id]: health(repositories[0].id, [{ kind: "dirty", count: 3 }]),
      [repositories[1].id]: health(repositories[1].id, [
        { kind: "wrongBranch", expected: "develop", actual: null },
      ]),
      [repositories[2].id]: health(repositories[2].id, [
        { kind: "unreadable", reasonCode: "repository_not_found" },
      ]),
    };

    expect(countOnExpectedBranch(repositories, healthByRepo)).toEqual({
      onExpected: 1,
      known: 2,
      total: 3,
    });
  });
});

describe("WorkspaceSettingsDialog", () => {
  it("saves a trimmed expected branch exactly once, and only on Save", async () => {
    const onSave = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <WorkspaceSettingsDialog workspace={workspace(null)} onSave={onSave} onClose={onClose} />,
    );

    fireEvent.change(screen.getByLabelText("Expected branch"), {
      target: { value: "  develop  " },
    });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith("develop");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("initializes from the persisted value and clears it with an empty field", async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <WorkspaceSettingsDialog
        workspace={workspace("develop")}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Expected branch") as HTMLInputElement;
    expect(input.value).toBe("develop");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("does not mutate when the value is unchanged or when cancelled", () => {
    const onSave = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <WorkspaceSettingsDialog workspace={workspace("develop")} onSave={onSave} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Expected branch"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps a backend validation error in the dialog instead of faking success", async () => {
    const onSave = vi.fn(async () => {
      throw { code: "expected_branch_invalid", message: "invalid" };
    });
    const onClose = vi.fn();
    render(
      <WorkspaceSettingsDialog workspace={workspace(null)} onSave={onSave} onClose={onClose} />,
    );

    fireEvent.change(screen.getByLabelText("Expected branch"), {
      target: { value: "not a branch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("translated:expected_branch_invalid"),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
