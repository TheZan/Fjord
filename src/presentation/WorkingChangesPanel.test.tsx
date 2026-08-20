import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingChangesPanel } from "@/presentation/WorkingChangesPanel";
import type { WorkingChanges } from "@/domain/git";

const loadUiState = vi.fn();
const saveRepoModes = vi.fn();

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: (...args: unknown[]) => loadUiState(...args),
  saveRepoModes: (...args: unknown[]) => saveRepoModes(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "working.commit") return `Commit ${values?.count ?? 0}`;
      if (key === "working.amendPublishedWarning") return `Published on ${values?.upstream}`;
      return key;
    },
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      size: 29,
      start: index * 29,
    })),
  }),
}));

const changes: WorkingChanges = {
  unstaged: [
    { path: "src/app.ts", changeType: "modified", conflicted: false },
    { path: "src/conflict.ts", changeType: "modified", conflicted: true },
  ],
  staged: [{ path: "README.md", changeType: "added", conflicted: false }],
};

function props(overrides: Partial<React.ComponentProps<typeof WorkingChangesPanel>> = {}) {
  return {
    changes,
    loading: false,
    error: null,
    busy: false,
    validated: true,
    selectedFile: null,
    onSelectFile: vi.fn(),
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onPrepareAmend: vi.fn(async () => ({ message: "Previous commit", publishedUpstream: null })),
    onCommit: vi.fn(async () => true),
    ...overrides,
  };
}

describe("WorkingChangesPanel", () => {
  beforeEach(() => {
    loadUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "unified", fileViewMode: "path" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    });
    saveRepoModes.mockResolvedValue(undefined);
  });

  it("restores and persists the file view mode", async () => {
    loadUiState.mockResolvedValue({
      version: 1,
      sidebar: { width: null, collapsedWorkspaces: [] },
      repo: { treeWidth: null, inspectorWidth: null, diffMode: "split", fileViewMode: "tree" },
      selection: { workspaceId: null, repositoryId: null },
      overview: { filters: [] },
    });
    render(<WorkingChangesPanel {...props()} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "fileView.tree" })).toHaveAttribute(
        "data-selected",
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "fileView.path" }));
    expect(saveRepoModes).toHaveBeenCalledWith(null, "path");
  });

  it("keeps staged and unstaged actions scoped to the correct files", () => {
    const panelProps = props();
    render(<WorkingChangesPanel {...panelProps} />);

    fireEvent.click(screen.getByText("app.ts"));
    expect(panelProps.onSelectFile).toHaveBeenCalledWith({ path: "src/app.ts", staged: false });

    fireEvent.click(screen.getByRole("button", { name: "working.stageAll" }));
    expect(panelProps.onStage).toHaveBeenCalledWith(["src/app.ts", "src/conflict.ts"]);
    fireEvent.click(screen.getAllByRole("button", { name: "working.stage" })[1]);
    expect(panelProps.onStage).toHaveBeenCalledWith(["src/conflict.ts"]);

    fireEvent.click(screen.getByRole("button", { name: "working.unstageAll" }));
    expect(panelProps.onUnstage).toHaveBeenCalledWith(["README.md"]);
    expect(screen.getByText("working.conflicted")).toBeInTheDocument();
  });

  it("forwards exact staged and unstaged row identity in Path and Tree views", () => {
    const onFileContextMenu = vi.fn();
    render(<WorkingChangesPanel {...props({ onFileContextMenu })} />);

    fireEvent.contextMenu(screen.getByTitle("src/app.ts"), { clientX: 10, clientY: 20 });
    fireEvent.contextMenu(screen.getByTitle("README.md"), { clientX: 30, clientY: 40 });
    expect(onFileContextMenu).toHaveBeenNthCalledWith(
      1,
      changes.unstaged[0],
      { path: "src/app.ts", source: "worktree" },
      { x: 10, y: 20 },
    );
    expect(onFileContextMenu).toHaveBeenNthCalledWith(
      2,
      changes.staged[0],
      { path: "README.md", source: "index" },
      { x: 30, y: 40 },
    );

    fireEvent.click(screen.getByRole("button", { name: "fileView.tree" }));
    fireEvent.contextMenu(screen.getByTitle("src/app.ts"), { clientX: 50, clientY: 60 });
    expect(onFileContextMenu).toHaveBeenLastCalledWith(
      changes.unstaged[0],
      { path: "src/app.ts", source: "worktree" },
      { x: 50, y: 60 },
    );
  });

  it("composes a trimmed commit message and clears inputs after success", async () => {
    const onCommit = vi.fn(async () => true);
    render(<WorkingChangesPanel {...props({ onCommit })} />);

    fireEvent.change(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      target: { value: "  Add coverage  " },
    });
    fireEvent.change(screen.getByPlaceholderText("working.descriptionPlaceholder"), {
      target: { value: "  Explain behavior  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit 1" }));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("Add coverage\n\nExplain behavior", false, false));
    expect(screen.getByPlaceholderText("working.summaryPlaceholder")).toHaveValue("");
    expect(screen.getByPlaceholderText("working.descriptionPlaceholder")).toHaveValue("");
  });

  it("blocks unvalidated mutations and retains the draft after a failed commit", async () => {
    const onCommit = vi.fn(async () => false);
    const panelProps = props({ onCommit, validated: false });
    const view = render(<WorkingChangesPanel {...panelProps} />);
    fireEvent.change(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      target: { value: "Keep me" },
    });

    expect(screen.getByRole("button", { name: "working.stageAll" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit 1" })).toBeDisabled();
    view.rerender(<WorkingChangesPanel {...panelProps} validated />);
    document.dispatchEvent(new CustomEvent("fjord:commit"));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("Keep me", false, false));
    expect(screen.getByPlaceholderText("working.summaryPlaceholder")).toHaveValue("Keep me");
  });

  it("prefills amend, warns for a published HEAD, and restores the draft when disabled", async () => {
    const onPrepareAmend = vi.fn(async () => ({
      message: "Published subject\n\nPublished body",
      publishedUpstream: "origin/main",
    }));
    render(<WorkingChangesPanel {...props({ onPrepareAmend })} />);
    fireEvent.change(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      target: { value: "Draft subject" },
    });
    fireEvent.change(screen.getByPlaceholderText("working.descriptionPlaceholder"), {
      target: { value: "Draft body" },
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "working.amend" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Published on origin/main"));
    expect(screen.getByPlaceholderText("working.summaryPlaceholder")).toHaveValue("Published subject");
    expect(screen.getByPlaceholderText("working.descriptionPlaceholder")).toHaveValue("Published body");
    expect(screen.getByRole("button", { name: "working.amendCommit" })).toBeEnabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "working.amend" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("working.summaryPlaceholder")).toHaveValue("Draft subject");
    expect(screen.getByPlaceholderText("working.descriptionPlaceholder")).toHaveValue("Draft body");
  });

  it("runs commit and push as one deliberate action", async () => {
    const onCommit = vi.fn(async () => true);
    render(<WorkingChangesPanel {...props({ onCommit })} />);
    fireEvent.change(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      target: { value: "Ship together" },
    });

    fireEvent.click(screen.getByRole("button", { name: "working.commitAndPush" }));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("Ship together", false, true));
  });
});
