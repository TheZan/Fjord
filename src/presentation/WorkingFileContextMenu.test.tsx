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

const normal: WorkingFile = { path: "src/app.ts", changeType: "modified", conflicted: false };
const worktree: WorkingFileTarget = { path: normal.path, source: "worktree" };
const index: WorkingFileTarget = { path: normal.path, source: "index" };
const t = ((key: string) => key) as never;

describe("WorkingFileContextMenu", () => {
  it("builds distinct unstaged and staged action sets", () => {
    const unstaged = ids(workingFileMenuItems(normal, worktree, false, t));
    const staged = ids(workingFileMenuItems(normal, index, false, t));

    expect(unstaged).toEqual(expect.arrayContaining(["stage", "discard", "openEditor", "copyPath"]));
    expect(unstaged).not.toContain("unstage");
    expect(staged).toEqual(expect.arrayContaining(["unstage", "openEditor", "copyPath"]));
    expect(staged).not.toContain("stage");
    expect(staged).not.toContain("discard");
  });

  it("withholds mutations for conflicts and hides file launches for deleted rows", () => {
    const conflict = ids(workingFileMenuItems({ ...normal, conflicted: true }, worktree, false, t));
    expect(conflict).toEqual(["openEditor", "openDefault", "reveal", "openMergeTool", "copyPath"]);

    const deleted = ids(workingFileMenuItems({ ...normal, changeType: "deleted" }, worktree, false, t));
    expect(deleted).toContain("discard");
    expect(deleted).not.toEqual(expect.arrayContaining(["openEditor", "openDefault", "reveal"]));
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
