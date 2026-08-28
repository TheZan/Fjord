import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingChangesPanel } from "@/presentation/WorkingChangesPanel";
import type { WorkingChanges } from "@/domain/git";
import type { WorkingFileSelectionController } from "@/application/useWorkingFileSelection";
import { useWorkingFileSelection } from "@/application/useWorkingFileSelection";

const loadUiState = vi.fn();
const saveRepoModes = vi.fn();
let virtualWindow: number[] | null = null;

vi.mock("@/infrastructure/uiState", () => ({
  loadUiState: (...args: unknown[]) => loadUiState(...args),
  saveRepoModes: (...args: unknown[]) => saveRepoModes(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "working.commit") return `Commit ${values?.count ?? 0}`;
      if (key === "working.amendPublishedWarning") return `Published on ${values?.upstream}`;
      if (key === "workingChanges.selectionAnnouncement") {
        return `${values?.count ?? 0} of ${values?.total ?? 0} selected`;
      }
      if (key === "workingChanges.selectedCount") return `${values?.count} selected`;
      if (key === "workingChanges.selectionActions") return `Actions for ${values?.count} selected files`;
      if (key === "workingChanges.clearSelection") return "Clear";
      if (key === "workingFile.stageFiles") return `Stage ${values?.count} files`;
      if (key === "workingFile.unstageFiles") return `Unstage ${values?.count} files`;
      if (key === "workingFile.stashFiles") return `Stash ${values?.count} files…`;
      return key;
    },
  }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    scrollToIndex: vi.fn(),
    getVirtualItems: () => (virtualWindow ?? Array.from({ length: count }, (_, index) => index))
      .filter((index) => index < count)
      .map((index) => ({
      index,
      key: index,
      size: 29,
      start: index * 29,
    })),
  }),
}));

const changes: WorkingChanges = {
  unstaged: [
    { path: "src/app.ts", changeType: "modified", tracked: true, conflicted: false },
    { path: "src/conflict.ts", changeType: "modified", tracked: true, conflicted: true },
  ],
  staged: [{ path: "README.md", changeType: "added", tracked: true, conflicted: false }],
};

function props(overrides: Partial<React.ComponentProps<typeof WorkingChangesPanel>> = {}) {
  const base: React.ComponentProps<typeof WorkingChangesPanel> = {
    changes,
    loading: false,
    error: null,
    busy: false,
    validated: true,
    selection: selectionController(),
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onSelectionAction: vi.fn(),
    onPrepareAmend: vi.fn(async () => ({ message: "Previous commit", publishedUpstream: null })),
    onCommit: vi.fn(async () => true),
  };
  return { ...base, ...overrides };
}

function selectionController(
  overrides: Partial<WorkingFileSelectionController> = {},
): WorkingFileSelectionController {
  return {
    targets: new Set(),
    source: null,
    active: null,
    anchor: null,
    isSelected: vi.fn(() => false),
    selectedPaths: vi.fn(() => new Set<string>()),
    select: vi.fn(),
    selectAll: vi.fn(),
    activate: vi.fn(),
    prepareContextMenu: vi.fn(),
    registerVisibleTargets: vi.fn(),
    clear: vi.fn(),
    beginSourceRemap: vi.fn(() => true),
    completeSourceRemap: vi.fn(),
    ...overrides,
  };
}

describe("WorkingChangesPanel", () => {
  beforeEach(() => {
    virtualWindow = null;
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
    expect(panelProps.selection.select).toHaveBeenCalledWith(
      { path: "src/app.ts", source: "worktree" },
      [],
      { toggle: false, range: false },
    );

    fireEvent.click(screen.getByRole("button", { name: "working.stageAll" }));
    expect(panelProps.onStage).toHaveBeenCalledWith(["src/app.ts", "src/conflict.ts"]);
    fireEvent.click(screen.getAllByRole("button", { name: "working.stage" })[1]);
    expect(panelProps.onStage).toHaveBeenCalledWith(["src/conflict.ts"]);

    fireEvent.click(screen.getByRole("button", { name: "working.unstageAll" }));
    expect(panelProps.onUnstage).toHaveBeenCalledWith(["README.md"]);
    expect(screen.getByText("working.conflicted")).toBeInTheDocument();
  });

  it("shows the shared unstaged selection toolbar, dispatches its full selection, and clears", () => {
    const toolbarChanges: WorkingChanges = {
      unstaged: [
        { path: "b.ts", changeType: "modified", tracked: true, conflicted: false },
        { path: "a.ts", changeType: "modified", tracked: true, conflicted: false },
      ],
      staged: [],
    };
    const targets = new Set([
      { path: "b.ts", source: "worktree" as const },
      { path: "a.ts", source: "worktree" as const },
    ]);
    const clear = vi.fn();
    const onSelectionAction = vi.fn();
    const selection = selectionController({
      targets,
      source: "worktree",
      active: { path: "b.ts", source: "worktree" },
      anchor: { path: "b.ts", source: "worktree" },
      selectedPaths: vi.fn((source) => source === "worktree"
        ? new Set<string>(["a.ts", "b.ts"])
        : new Set<string>()),
      clear,
    });
    render(<WorkingChangesPanel {...props({
      changes: toolbarChanges,
      selection,
      onSelectionAction,
    })} />);

    const toolbar = screen.getByTestId("worktree-selection-toolbar");
    expect(toolbar).toHaveTextContent("2 selected");
    expect(toolbar).toHaveClass("flex-wrap");
    const stageButton = screen.getByRole("button", { name: "Stage 2 files" });
    const stashButton = screen.getByRole("button", { name: "Stash 2 files…" });
    expect(stageButton).toBeEnabled();
    expect(stashButton).toBeEnabled();
    expect(stageButton).toHaveClass("shrink-0", "whitespace-nowrap");
    expect(stashButton).toHaveClass("shrink-0", "whitespace-nowrap");
    expect(screen.queryByRole("button", { name: /Discard|patch/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stage 2 files" }));
    const expectedContext = {
      clickedTarget: { path: "b.ts", source: "worktree" },
      targets: [
        { path: "b.ts", source: "worktree" },
        { path: "a.ts", source: "worktree" },
      ],
    };
    expect(onSelectionAction).toHaveBeenCalledWith("stage", expectedContext);

    fireEvent.click(screen.getByRole("button", { name: "Actions for 2 selected files" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stage 2 files" }));
    expect(onSelectionAction).toHaveBeenLastCalledWith("stage", expectedContext);

    const clearButton = screen.getByRole("button", { name: "Clear" });
    expect(clearButton).toHaveClass("shrink-0", "whitespace-nowrap");
    fireEvent.click(clearButton);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("shows only Unstage as the staged selection toolbar primary mutation", () => {
    const toolbarChanges: WorkingChanges = {
      unstaged: [],
      staged: [
        { path: "a.ts", changeType: "modified", tracked: true, conflicted: false },
        { path: "b.ts", changeType: "modified", tracked: true, conflicted: false },
      ],
    };
    const targets = new Set([
      { path: "a.ts", source: "index" as const },
      { path: "b.ts", source: "index" as const },
    ]);
    const selection = selectionController({
      targets,
      source: "index",
      active: { path: "a.ts", source: "index" },
      anchor: { path: "a.ts", source: "index" },
      selectedPaths: vi.fn((source) => source === "index"
        ? new Set<string>(["a.ts", "b.ts"])
        : new Set<string>()),
    });
    render(<WorkingChangesPanel {...props({ changes: toolbarChanges, selection })} />);

    expect(screen.getByRole("button", { name: "Unstage 2 files" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Stash/ })).not.toBeInTheDocument();
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

  it("prefills a pending draft message (e.g. from a squash merge) and consumes it exactly once", () => {
    const onPendingDraftMessageConsumed = vi.fn();
    const view = render(
      <WorkingChangesPanel
        {...props({ onPendingDraftMessageConsumed })}
        pendingDraftMessage={"Squash of feature/x\n\nCombined change details"}
      />,
    );

    expect(screen.getByPlaceholderText("working.summaryPlaceholder")).toHaveValue("Squash of feature/x");
    expect(screen.getByPlaceholderText("working.descriptionPlaceholder")).toHaveValue(
      "Combined change details",
    );
    expect(onPendingDraftMessageConsumed).toHaveBeenCalledTimes(1);

    // Consumption clears the prop; re-rendering with the same (already
    // consumed) value must not overwrite further edits.
    fireEvent.change(screen.getByPlaceholderText("working.summaryPlaceholder"), {
      target: { value: "Edited after prefill" },
    });
    view.rerender(
      <WorkingChangesPanel
        {...props({ onPendingDraftMessageConsumed })}
        pendingDraftMessage={null}
      />,
    );
    expect(screen.getByPlaceholderText("working.summaryPlaceholder")).toHaveValue("Edited after prefill");
    expect(onPendingDraftMessageConsumed).toHaveBeenCalledTimes(1);
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

  it("keeps selection source-homogeneous and scopes primary+A to the focused section", () => {
    const onStage = vi.fn();
    const onUnstage = vi.fn();
    render(<SelectionHarness onStage={onStage} onUnstage={onUnstage} />);
    const app = screen.getByTitle("src/app.ts");
    const conflict = screen.getByTitle("src/conflict.ts");
    const staged = screen.getByTitle("README.md");

    fireEvent.click(app);
    fireEvent.click(conflict, { ctrlKey: true });
    expect(app).toHaveAttribute("aria-selected", "true");
    expect(conflict).toHaveAttribute("aria-selected", "true");

    fireEvent.focus(staged);
    fireEvent.keyDown(staged, { key: "a", code: "KeyA", ctrlKey: true });
    expect(staged).toHaveAttribute("aria-selected", "true");
    expect(app).toHaveAttribute("aria-selected", "false");
    expect(conflict).toHaveAttribute("aria-selected", "false");
    expect(onStage).not.toHaveBeenCalled();
    expect(onUnstage).not.toHaveBeenCalled();
  });

  it("preserves an inside context selection and replaces it outside for mouse and keyboard", () => {
    const onFileContextMenu = vi.fn();
    render(<SelectionHarness onFileContextMenu={onFileContextMenu} />);
    const app = screen.getByTitle("src/app.ts");
    const conflict = screen.getByTitle("src/conflict.ts");

    fireEvent.click(app);
    fireEvent.click(conflict, { ctrlKey: true });
    fireEvent.contextMenu(app, { clientX: 10, clientY: 20 });
    expect(app).toHaveAttribute("aria-selected", "true");
    expect(conflict).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(conflict, { key: "ContextMenu" });
    expect(app).toHaveAttribute("aria-selected", "true");
    expect(conflict).toHaveAttribute("aria-selected", "true");

    const staged = screen.getByTitle("README.md");
    fireEvent.contextMenu(staged, { clientX: 30, clientY: 40 });
    expect(staged).toHaveAttribute("aria-selected", "true");
    expect(app).toHaveAttribute("aria-selected", "false");

    fireEvent.click(app);
    fireEvent.click(conflict, { ctrlKey: true });
    fireEvent.keyDown(staged, { key: "F10", shiftKey: true });
    expect(staged).toHaveAttribute("aria-selected", "true");
    expect(app).toHaveAttribute("aria-selected", "false");
    expect(onFileContextMenu).toHaveBeenCalledTimes(4);
  });

  it("implements arrow extension, toggle-in-place, Escape collapse, and count announcements", () => {
    render(<SelectionHarness />);
    const app = screen.getByTitle("src/app.ts");

    fireEvent.click(app);
    fireEvent.keyDown(app, { key: "ArrowDown" });
    const conflict = screen.getByTitle("src/conflict.ts");
    expect(conflict).toHaveAttribute("tabindex", "0");
    expect(conflict).toHaveAttribute("aria-selected", "true");
    expect(app).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(conflict, { key: "ArrowUp", shiftKey: true });
    expect(app).toHaveAttribute("aria-selected", "true");
    expect(conflict).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 2 selected");

    fireEvent.keyDown(app, { key: " ", metaKey: true });
    expect(app).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(app, { key: "Escape" });
    expect(app).toHaveAttribute("aria-selected", "true");
    expect(conflict).toHaveAttribute("aria-selected", "false");
  });

  it("preserves logical selection while Tree rows unmount and remount", () => {
    render(<SelectionHarness />);
    fireEvent.click(screen.getByTitle("src/app.ts"));
    fireEvent.click(screen.getByTitle("src/conflict.ts"), { ctrlKey: true });

    fireEvent.click(screen.getByRole("button", { name: "fileView.tree" }));
    const directory = screen.getByRole("button", { name: /src/ });
    fireEvent.click(directory);
    expect(screen.queryByTitle("src/app.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 of 2 selected");

    fireEvent.click(directory);
    expect(screen.getByTitle("src/app.ts")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle("src/conflict.ts")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "fileView.path" }));
    expect(screen.getByTitle("src/app.ts")).toHaveAttribute("aria-selected", "true");
  });

  it("preserves selection and anchor across real virtualizer unmount/remount", () => {
    const largeChanges: WorkingChanges = {
      unstaged: Array.from({ length: 80 }, (_, index) => ({
        path: `src/file-${index.toString().padStart(3, "0")}.ts`,
        changeType: "modified" as const,
        tracked: true,
        conflicted: false,
      })),
      staged: [],
    };
    virtualWindow = [0, 1, 2];
    const view = render(
      <SelectionHarness currentChanges={largeChanges} virtualRevision={0} />,
    );
    const anchorPath = "src/file-000.ts";
    const endPath = "src/file-002.ts";

    fireEvent.click(screen.getByTitle(anchorPath));
    fireEvent.click(screen.getByTitle(endPath), { shiftKey: true });
    expect(screen.getByTitle(anchorPath)).toHaveAttribute("aria-selected", "true");

    virtualWindow = [50, 51, 52];
    view.rerender(<SelectionHarness currentChanges={largeChanges} virtualRevision={1} />);
    expect(screen.queryByTitle(anchorPath)).not.toBeInTheDocument();
    expect(screen.getByTitle("src/file-050.ts")).toBeInTheDocument();

    virtualWindow = [0, 1, 2];
    view.rerender(<SelectionHarness currentChanges={largeChanges} virtualRevision={2} />);
    expect(screen.getByTitle(anchorPath)).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByTitle("src/file-001.ts"), { shiftKey: true });
    expect(screen.getByTitle(anchorPath)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle("src/file-001.ts")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle(endPath)).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 80 selected");
  });

  it("drops disappeared targets and clears the selection when the repository changes", async () => {
    const view = render(<SelectionHarness />);
    fireEvent.click(screen.getByTitle("src/app.ts"));
    fireEvent.click(screen.getByTitle("src/conflict.ts"), { ctrlKey: true });

    view.rerender(<SelectionHarness currentChanges={{ ...changes, unstaged: [changes.unstaged[0]] }} />);
    await waitFor(() => expect(screen.getByTitle("src/app.ts")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("status")).toHaveTextContent("1 of 1 selected");

    view.rerender(<SelectionHarness repositoryId="repo-2" />);
    await waitFor(() => expect(screen.getByTitle("src/app.ts")).toHaveAttribute("aria-selected", "false"));
  });

  it("uses the captured old order for active fallback after refresh", async () => {
    const orderedChanges: WorkingChanges = {
      unstaged: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((path) => ({
        path,
        changeType: "modified" as const,
        tracked: true,
        conflicted: false,
      })),
      staged: [],
    };
    const view = render(<SelectionHarness currentChanges={orderedChanges} />);
    fireEvent.click(screen.getByTitle("a.ts"));
    fireEvent.click(screen.getByTitle("d.ts"), { ctrlKey: true });
    fireEvent.click(screen.getByTitle("c.ts"), { ctrlKey: true });

    const withoutActive: WorkingChanges = {
      ...orderedChanges,
      unstaged: orderedChanges.unstaged.filter((file) => file.path !== "c.ts"),
    };
    view.rerender(<SelectionHarness currentChanges={withoutActive} />);

    await waitFor(() => expect(screen.getByTitle("d.ts")).toHaveAttribute("tabindex", "0"));
    expect(screen.getByTitle("a.ts")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle("d.ts")).toHaveAttribute("aria-selected", "true");
  });
});

function SelectionHarness({
  currentChanges = changes,
  repositoryId = "repo-1",
  onFileContextMenu = vi.fn(),
  onStage = vi.fn(),
  onUnstage = vi.fn(),
  virtualRevision = 0,
}: {
  currentChanges?: WorkingChanges;
  repositoryId?: string;
  onFileContextMenu?: React.ComponentProps<typeof WorkingChangesPanel>["onFileContextMenu"];
  onStage?: React.ComponentProps<typeof WorkingChangesPanel>["onStage"];
  onUnstage?: React.ComponentProps<typeof WorkingChangesPanel>["onUnstage"];
  virtualRevision?: number;
}) {
  void virtualRevision;
  const selection = useWorkingFileSelection(repositoryId, currentChanges);
  return (
    <WorkingChangesPanel
      {...props({ changes: currentChanges, selection, onFileContextMenu, onStage, onUnstage })}
    />
  );
}
