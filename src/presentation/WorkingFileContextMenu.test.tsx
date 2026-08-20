import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkingFile, WorkingFileTarget } from "@/domain/git";
import {
  WorkingFileContextMenu,
  workingFileMenuItems,
  type WorkingFileMenuState,
} from "@/presentation/WorkingFileContextMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const normal: WorkingFile = { path: "src/app.ts", changeType: "modified", tracked: true, conflicted: false };
const worktree: WorkingFileTarget = { path: normal.path, source: "worktree" };
const index: WorkingFileTarget = { path: normal.path, source: "index" };
const t = ((key: string) => key) as never;

describe("WorkingFileContextMenu", () => {
  it("builds distinct unstaged and staged action sets", () => {
    const unstaged = ids(workingFileMenuItems(normal, worktree, false, t));
    const staged = ids(workingFileMenuItems(normal, index, false, t));

    expect(unstaged).toEqual(expect.arrayContaining(["stage", "discard", "openEditor", "copyPath"]));
    expect(unstaged).toContain("ignore");
    expect(unstaged).not.toContain("unstage");
    expect(staged).toEqual(expect.arrayContaining(["unstage", "openEditor", "copyPath"]));
    expect(staged).not.toContain("stage");
    expect(staged).not.toContain("discard");
    expect(staged).not.toContain("ignore");
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

    const deleted = ids(workingFileMenuItems({ ...normal, changeType: "deleted" }, worktree, false, t));
    expect(deleted).toContain("discard");
    expect(deleted).not.toEqual(expect.arrayContaining(["openEditor", "openDefault", "reveal"]));
    expect(deleted).toEqual(expect.arrayContaining(["copyPath", "createPatch", "copyPatch"]));
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

    expect(onAction).toHaveBeenCalledWith("copyAbsolute", worktree);
  });
});

function ids(items: ReturnType<typeof workingFileMenuItems>) {
  return items.map((item) => item.id);
}
