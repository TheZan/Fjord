import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkingFile, WorkingFileTarget } from "@/domain/git";
import {
  WorkingFileContextMenu,
  workingFileMenuItems,
  type WorkingFileMenuState,
} from "@/presentation/WorkingFileContextMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "workingFile.stageFiles") return `Stage ${values?.count} files`;
      if (key === "workingFile.unstageFiles") return `Unstage ${values?.count} files`;
      if (key === "workingFile.stashFiles") return `Stash ${values?.count} files…`;
      if (key === "workingFile.discardFiles") return `Discard changes in ${values?.count} files…`;
      if (key === "workingFile.createPatchFiles") return `Create patch from ${values?.count} files…`;
      if (key === "workingFile.createPatchFilesStaged") return `Create patch from ${values?.count} staged files…`;
      if (key === "workingFile.copyPatchFiles") return `Copy patch for ${values?.count} files`;
      return key;
    },
  }),
}));

const normal: WorkingFile = { path: "src/app.ts", changeType: "modified", tracked: true, conflicted: false };
const worktree: WorkingFileTarget = { path: normal.path, source: "worktree" };
const index: WorkingFileTarget = { path: normal.path, source: "index" };
const t = vi.fn((key: string, values?: Record<string, unknown>) => {
  if (key === "workingFile.stageFiles") return `Stage ${values?.count} files`;
  if (key === "workingFile.unstageFiles") return `Unstage ${values?.count} files`;
  if (key === "workingFile.stashFiles") return `Stash ${values?.count} files…`;
  if (key === "workingFile.discardFiles") return `Discard changes in ${values?.count} files…`;
  if (key === "workingFile.createPatchFiles") return `Create patch from ${values?.count} files…`;
  if (key === "workingFile.createPatchFilesStaged") return `Create patch from ${values?.count} staged files…`;
  if (key === "workingFile.copyPatchFiles") return `Copy patch for ${values?.count} files`;
  if (key === "workingFile.disabled.conflictedSelection") return `${values?.path} conflicted`;
  return key;
}) as never;

describe("WorkingFileContextMenu", () => {
  it("builds distinct unstaged and staged action sets", () => {
    const unstaged = ids(workingFileMenuItems(normal, worktree, false, t));
    const staged = ids(workingFileMenuItems(normal, index, false, t));

    expect(unstaged).toEqual(expect.arrayContaining(["stage", "discard", "openEditor", "copyPath", "delete"]));
    expect(unstaged).toContain("ignore");
    expect(unstaged).not.toContain("unstage");
    expect(staged).toEqual(expect.arrayContaining(["unstage", "openEditor", "copyPath"]));
    expect(staged).not.toContain("stage");
    expect(staged).not.toContain("discard");
    expect(staged).not.toContain("ignore");
    expect(staged).not.toContain("delete");
  });

  it("builds the complete counted batch action sets from one shared item model", () => {
    const unstagedSelection = ["d.ts", "b.ts", "a.ts", "c.ts"].map((path) => ({
      file: { ...normal, path },
      target: { path, source: "worktree" as const },
    }));
    const stagedSelection = ["c.ts", "a.ts", "b.ts"].map((path) => ({
      file: { ...normal, path },
      target: { path, source: "index" as const },
    }));

    const unstaged = workingFileMenuItems({
      clicked: unstagedSelection[1],
      selection: unstagedSelection,
      busy: false,
    }, t);
    const staged = workingFileMenuItems({
      clicked: stagedSelection[0],
      selection: stagedSelection,
      busy: false,
    }, t);

    expect(unstaged.map((item) => [item.id, item.label])).toEqual([
      ["stage", "Stage 4 files"],
      ["discard", "Discard changes in 4 files…"],
      ["stashFile", "Stash 4 files…"],
      ["copyPaths", "workingFile.copyPaths"],
      ["createPatch", "Create patch from 4 files…"],
      ["copyPatch", "Copy patch for 4 files"],
    ]);
    expect(staged.map((item) => [item.id, item.label])).toEqual([
      ["unstage", "Unstage 3 files"],
      ["copyPaths", "workingFile.copyPaths"],
      ["createPatch", "Create patch from 3 staged files…"],
      ["copyPatch", "Copy patch for 3 files"],
    ]);
    expect(t).toHaveBeenCalledWith("workingFile.stageFiles", { count: 4 });
    expect(t).toHaveBeenCalledWith("workingFile.unstageFiles", { count: 3 });
    expect(ids(staged)).not.toContain("discard");
  });

  it("disables the whole MULTI-02 mutation set and names the conflicted path", () => {
    const selection = [
      { file: normal, target: worktree },
      {
        file: { ...normal, path: "src/conflict.ts", conflicted: true },
        target: { path: "src/conflict.ts", source: "worktree" as const },
      },
    ];
    const items = workingFileMenuItems({
      clicked: selection[0],
      selection,
      busy: false,
    }, t);

    expect(items).toHaveLength(6);
    expect(items.every((item) => item.disabled)).toBe(true);
    expect(items[0].disabledReason).toBe("src/conflict.ts conflicted");
  });

  it("dispatches all selected paths when right-clicking inside the selection", () => {
    const onAction = vi.fn();
    const selection = ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({
      file: { ...normal, path },
      target: { path, source: "worktree" as const },
    }));
    const state: WorkingFileMenuState = {
      file: selection[1].file,
      target: selection[1].target,
      position: { x: 10, y: 20 },
    };
    render(
      <WorkingFileContextMenu
        state={state}
        selection={selection}
        busy={false}
        onAction={onAction}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Stash 4 files…" }));
    expect(onAction).toHaveBeenCalledWith("stashFile", {
      clickedTarget: selection[1].target,
      targets: selection.map((entry) => entry.target),
    });
  });

  it("renders delete last, danger-styled, and enabled by default on the unstaged row only", () => {
    const unstaged = workingFileMenuItems(normal, worktree, false, t);
    expect(unstaged.at(-1)).toMatchObject({
      id: "delete",
      label: "workingFile.delete",
      danger: true,
      separatorBefore: true,
      disabled: false,
    });

    const staged = workingFileMenuItems(normal, index, false, t);
    expect(staged.find((item) => item.id === "delete")).toBeUndefined();
  });

  it("disables delete with the stated reason when the same path is also staged", () => {
    const blocked = workingFileMenuItems(normal, worktree, false, t, undefined, "workingFile.disabled.deleteAlsoStaged");
    expect(blocked.find((item) => item.id === "delete")).toMatchObject({
      disabled: true,
      disabledReason: "workingFile.disabled.deleteAlsoStaged",
    });
  });

  it("disables delete while busy", () => {
    const busy = workingFileMenuItems(normal, worktree, true, t);
    expect(busy.find((item) => item.id === "delete")).toMatchObject({ disabled: true });
  });

  it("offers patch export from both rows, with clipboard copy on the unstaged row only", () => {
    const unstaged = workingFileMenuItems(normal, worktree, false, t);
    const staged = workingFileMenuItems(normal, index, false, t);

    expect(unstaged.find((item) => item.id === "createPatch")).toMatchObject({
      label: "workingFile.createPatch",
      disabled: false,
    });
    expect(ids(unstaged)).toContain("copyPatch");

    expect(staged.find((item) => item.id === "createPatch")).toMatchObject({
      label: "workingFile.createPatchStaged",
      disabled: false,
    });
    expect(ids(staged)).not.toContain("copyPatch");
  });

  it("disables patch export with the stated reason while a whitespace-ignoring mode is active", () => {
    const items = workingFileMenuItems(normal, worktree, false, t, "workingFile.disabled.whitespaceMode");

    expect(items.find((item) => item.id === "createPatch")).toMatchObject({
      disabled: true,
      disabledReason: "workingFile.disabled.whitespaceMode",
    });
    expect(items.find((item) => item.id === "copyPatch")).toMatchObject({
      disabled: true,
      disabledReason: "workingFile.disabled.whitespaceMode",
    });
  });

  it("disables both batch patch actions as a unit in whitespace mode", () => {
    const selection = ["a.ts", "b.ts", "c.ts"].map((path) => ({
      file: { ...normal, path },
      target: { path, source: "worktree" as const },
    }));
    const items = workingFileMenuItems({
      clicked: selection[0],
      selection,
      busy: false,
      patchExportDisabledReason: "workingFile.disabled.whitespaceMode",
    }, t);

    expect(items.find((item) => item.id === "createPatch")).toMatchObject({
      disabled: true,
      disabledReason: "workingFile.disabled.whitespaceMode",
    });
    expect(items.find((item) => item.id === "copyPatch")).toMatchObject({
      disabled: true,
      disabledReason: "workingFile.disabled.whitespaceMode",
    });
    expect(items.find((item) => item.id === "discard")).toMatchObject({ disabled: false });
  });

  it("offers adaptive ignore rules only for untracked worktree files", () => {
    const trackedIgnore = workingFileMenuItems(normal, worktree, false, t).find((item) => item.id === "ignore");
    expect(trackedIgnore).toMatchObject({
      disabled: true,
      disabledReason: "workingFile.ignore.trackedFile",
    });

    const nested = workingFileMenuItems(
      { ...normal, tracked: false, path: "src/generated/debug.log" },
      { path: "src/generated/debug.log", source: "worktree" },
      false,
      t,
    ).find((item) => item.id === "ignore");
    expect(nested?.children?.map((item) => item.id)).toEqual([
      "ignoreFile",
      "ignoreExtension",
      "ignoreDirectory",
    ]);

    const rootDotfile = workingFileMenuItems(
      { ...normal, tracked: false, path: ".env" },
      { path: ".env", source: "worktree" },
      false,
      t,
    ).find((item) => item.id === "ignore");
    expect(rootDotfile?.children?.map((item) => item.id)).toEqual(["ignoreFile"]);
  });

  it("withholds mutations for conflicts and hides file launches for deleted rows", () => {
    const conflict = ids(workingFileMenuItems({ ...normal, conflicted: true }, worktree, false, t));
    expect(conflict).toEqual(["openEditor", "openDefault", "reveal", "openMergeTool", "copyPath"]);
    expect(conflict).not.toContain("openExternalDiff");
    expect(conflict).not.toContain("stashFile");

    const deleted = ids(workingFileMenuItems({ ...normal, changeType: "deleted" }, worktree, false, t));
    expect(deleted).toContain("discard");
    expect(deleted).not.toEqual(expect.arrayContaining(["openEditor", "openDefault", "reveal", "delete"]));
    expect(deleted).toEqual(expect.arrayContaining(["copyPath", "createPatch", "copyPatch", "openExternalDiff"]));
  });

  it("offers Stash file only on the unstaged row, and external diff on both", () => {
    const unstaged = ids(workingFileMenuItems(normal, worktree, false, t));
    const staged = ids(workingFileMenuItems(normal, index, false, t));

    expect(unstaged).toContain("stashFile");
    expect(unstaged).toContain("openExternalDiff");
    expect(staged).not.toContain("stashFile");
    expect(staged).toContain("openExternalDiff");
  });

  it("disables Stash file with the stated reason on an unsupported Git", () => {
    const items = workingFileMenuItems(normal, worktree, false, t, undefined, undefined, undefined, "workingFile.stashFile.unsupportedGit");
    expect(items.find((item) => item.id === "stashFile")).toMatchObject({
      disabled: true,
      disabledReason: "workingFile.stashFile.unsupportedGit",
    });
  });

  it("disables the external diff entry with the stated reason when no tool resolves", () => {
    const items = workingFileMenuItems(normal, worktree, false, t, undefined, undefined, "workingFile.disabled.noDiffTool");
    expect(items.find((item) => item.id === "openExternalDiff")).toMatchObject({
      disabled: true,
      disabledReason: "workingFile.disabled.noDiffTool",
    });
  });

  it("dispatches the exact row target and exposes copy-path children through the shared submenu", async () => {
    const onAction = vi.fn();
    const state: WorkingFileMenuState = { file: normal, target: worktree, position: { x: 10, y: 20 } };
    render(
      <WorkingFileContextMenu
        state={state}
        busy={false}
        onAction={onAction}
        onClose={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "workingFile.copyPath.label" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "workingFile.copyPath.relative" })).toHaveFocus());
    fireEvent.click(screen.getByRole("menuitem", { name: "workingFile.copyPath.absolute" }));

    expect(onAction).toHaveBeenCalledWith("copyAbsolute", {
      clickedTarget: worktree,
      targets: [worktree],
    });
  });

  it("dispatches delete for the exact unstaged target when clicked", () => {
    const onAction = vi.fn();
    const state: WorkingFileMenuState = { file: normal, target: worktree, position: { x: 10, y: 20 } };
    render(
      <WorkingFileContextMenu
        state={state}
        busy={false}
        onAction={onAction}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "workingFile.delete" }));

    expect(onAction).toHaveBeenCalledWith("delete", {
      clickedTarget: worktree,
      targets: [worktree],
    });
  });

  it("dispatches stashFile and openExternalDiff for the exact target when clicked", () => {
    const onAction = vi.fn();
    const state: WorkingFileMenuState = { file: normal, target: worktree, position: { x: 10, y: 20 } };
    render(
      <WorkingFileContextMenu
        state={state}
        busy={false}
        onAction={onAction}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "workingFile.stashFile.label" }));
    expect(onAction).toHaveBeenCalledWith("stashFile", {
      clickedTarget: worktree,
      targets: [worktree],
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "workingFile.openExternalDiff" }));
    expect(onAction).toHaveBeenCalledWith("openExternalDiff", {
      clickedTarget: worktree,
      targets: [worktree],
    });
  });

  it("does not dispatch when the disabled delete entry is activated", () => {
    const onAction = vi.fn();
    const state: WorkingFileMenuState = { file: normal, target: worktree, position: { x: 10, y: 20 } };
    render(
      <WorkingFileContextMenu
        state={state}
        busy={false}
        deleteDisabledReason="workingFile.disabled.deleteAlsoStaged"
        onAction={onAction}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "workingFile.delete" }));

    expect(onAction).not.toHaveBeenCalled();
  });
});

function ids(items: ReturnType<typeof workingFileMenuItems>) {
  return items.map((item) => item.id);
}
