import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { useStashes } from "@/application/useStashes";
import { RepoToolbar } from "@/presentation/RepoToolbar";
import type { RepoStatus } from "@/domain/git";
import type { RepositoryEntry } from "@/domain/workspace";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      key === "operations.progress" ? `${values?.completed}/${values?.total}` : key,
  }),
}));

vi.mock("@/application/useStashes", () => ({ useStashes: vi.fn() }));

const repo: RepositoryEntry = {
  id: "repo-1",
  workspaceId: "workspace-1",
  name: "Fjord",
  path: "/dev/fjord",
  sortOrder: 0,
};
const status: RepoStatus = {
  branch: "main",
  ahead: 2,
  behind: 1,
  dirtyCount: 3,
  hasConflict: false,
};

function props(overrides: Partial<React.ComponentProps<typeof RepoToolbar>> = {}) {
  return {
    repo,
    status,
    dataValidated: true,
    actionPending: null,
    operationProgress: null,
    onBack: vi.fn(),
    onAction: vi.fn(),
    onCancelOperation: vi.fn(),
    onCreateBranch: vi.fn(),
    utilities: <button type="button">shell search</button>,
    onOpenInspector: vi.fn(),
    ...overrides,
  };
}

describe("RepoToolbar", () => {
  beforeEach(() => {
    vi.mocked(useStashes).mockReturnValue({ stashes: [], loading: false, error: null });
  });

  it("passes an automated accessibility scan", async () => {
    const { container } = render(<RepoToolbar {...props()} />);
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });

  it("blocks repository mutations until validation but keeps non-mutating tools available", () => {
    const toolbarProps = props({ dataValidated: false });
    render(<RepoToolbar {...toolbarProps} />);

    expect(screen.getByRole("button", { name: "repoActions.fetch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "toolbar.branch" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "toolbar.moreActions" }));
    expect(screen.getByRole("menuitem", { name: "toolbar.terminal" })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "toolbar.terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "shell search" }));
    expect(toolbarProps.onAction).toHaveBeenCalledWith("terminal");
  });

  it("enforces stash availability and dispatches enabled actions", () => {
    const toolbarProps = props({ status: { ...status, dirtyCount: 0 } });
    const view = render(<RepoToolbar {...toolbarProps} />);
    fireEvent.click(screen.getByRole("button", { name: "toolbar.moreActions" }));
    expect(screen.getByRole("menuitem", { name: "toolbar.stash" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "toolbar.stash" })).toHaveAttribute(
      "title",
      "toolbar.nothingToStash",
    );
    expect(screen.getByRole("menuitem", { name: "toolbar.pop" })).toBeDisabled();

    vi.mocked(useStashes).mockReturnValue({
      stashes: [{ index: 0, message: "WIP" }],
      loading: false,
      error: null,
    });
    view.rerender(<RepoToolbar {...toolbarProps} status={status} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "toolbar.stash" }));
    fireEvent.click(screen.getByRole("button", { name: "toolbar.moreActions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /toolbar.pop/ }));
    expect(toolbarProps.onAction).toHaveBeenCalledWith("stash");
    expect(toolbarProps.onAction).toHaveBeenCalledWith("stash-pop");
  });

  it("keeps primary and utility actions visible while rare actions live in overflow", () => {
    render(<RepoToolbar {...props()} />);

    expect(screen.getByRole("button", { name: "shell search" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "toolbar.search" })).not.toBeInTheDocument();

    for (const name of ["repoActions.fetch", "repoActions.pull", "repoActions.push", "toolbar.branch"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeVisible();
      expect(button.querySelector("svg")).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "repoActions.openIde" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "toolbar.stash" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "toolbar.moreActions" }));
    expect(screen.getByRole("menuitem", { name: "toolbar.stash" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "toolbar.terminal" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "repoStatus.openMergeTool" })).toHaveAttribute(
      "title",
      "toolbar.noConflicts",
    );
    expect(screen.getByRole("menuitem", { name: "inspector.open" })).toBeInTheDocument();
  });

  it("trims a new branch name and closes the branch popover", () => {
    const toolbarProps = props();
    render(<RepoToolbar {...toolbarProps} />);

    fireEvent.click(screen.getByRole("button", { name: "toolbar.branch" }));
    const input = screen.getByPlaceholderText("toolbar.branchPlaceholder");
    fireEvent.change(input, { target: { value: "  feature/tests  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(toolbarProps.onCreateBranch).toHaveBeenCalledWith("feature/tests");
    expect(screen.queryByPlaceholderText("toolbar.branchPlaceholder")).not.toBeInTheDocument();
  });

  it("shows clamped operation progress and cancels the operation", () => {
    const toolbarProps = props({
      actionPending: "fetch",
      operationProgress: { completed: 5, total: 2, error: null, status: "fetching" },
    });
    const { container } = render(<RepoToolbar {...toolbarProps} />);

    expect(screen.getByRole("button", { name: "repoActions.fetch" })).toBeDisabled();
    expect(screen.getByText("5/2")).toBeInTheDocument();
    expect(container.querySelector('[style*="width: 100%"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "operations.cancel" }));
    expect(toolbarProps.onCancelOperation).toHaveBeenCalledOnce();
  });
});
