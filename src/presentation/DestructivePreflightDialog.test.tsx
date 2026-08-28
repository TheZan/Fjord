import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { DestructiveAction, DestructivePreflight, PatchSelection } from "@/domain/generated";
import { DestructivePreflightDialog } from "@/presentation/DestructivePreflightDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}));

const action: DestructiveAction = {
  kind: "discard",
  selection: { kind: "file", path: "src/main.rs" },
};
const patchSelection: PatchSelection = {
  path: "src/main.rs",
  source: "worktree",
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }],
  baseDigest: "digest",
};

function preflight(
  workingTree: number,
  count = 3,
  blockers: string[] = [],
  confirmationToken: string | null = "confirmation-token",
  requestedAction: DestructiveAction = action,
  consequences: DestructivePreflight["consequences"] = [{ kind: "modifiedLinesDiscarded", path: "src/main.rs", count }],
): DestructivePreflight {
  return {
    action: requestedAction,
    consequences,
    recoverable: "notRecoverable",
    blockers,
    generations: { workingTree, refs: 0, history: 0, stash: 0, config: 0 },
    forceWithLease: null,
    confirmationToken,
  };
}

describe("DestructivePreflightDialog", () => {
  it("re-runs preflight at confirmation and never executes stale facts", async () => {
    const loadPreflight = vi
      .fn()
      .mockResolvedValueOnce(preflight(1, 3, [], "token-1"))
      .mockResolvedValueOnce(preflight(2, 5, [], "token-2"))
      .mockResolvedValueOnce(preflight(2, 5, [], "token-3"));
    const onConfirm = vi.fn();
    render(
      <DestructivePreflightDialog
        repoId="repo-1"
        action={action}
        patchSelection={patchSelection}
        loadPreflight={loadPreflight}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );

    const confirm = await screen.findByRole("button", { name: "preflight.discard.confirm" });
    fireEvent.click(confirm);

    await screen.findByText("preflight.changed");
    expect(screen.getByText("preflight.consequences.modifiedLinesDiscarded:5")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(preflight(2, 5).generations, "token-3"));
    expect(loadPreflight).toHaveBeenCalledTimes(3);
  });

  it("exposes blockers accessibly and disables confirmation", async () => {
    const { container } = render(
      <DestructivePreflightDialog
        repoId="repo-1"
        action={action}
        patchSelection={patchSelection}
        loadPreflight={vi.fn().mockResolvedValue(preflight(1, 0, ["selection_changed"]))}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "preflight.discard.title" });
    expect(screen.getByRole("alert")).toHaveTextContent("preflight.blockers.selection_changed");
    expect(screen.getByRole("button", { name: "preflight.discard.confirm" })).toBeDisabled();
    expect(dialog).toHaveAttribute("aria-describedby");
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it.each([
    [{ kind: "reset", commitId: "abc", mode: "hard" }, { kind: "commitsUnreachable", count: 2, sample: [] }],
    [{ kind: "deleteBranch", name: "topic" }, { kind: "branchDeleted", name: "topic", unmergedInto: "main" }],
    [{ kind: "deleteRemoteBranch", remote: "origin", branch: "topic" }, { kind: "remoteRefUpdated", remote: "origin", refName: "refs/heads/topic", droppedCommits: 1 }],
    [{ kind: "deleteTag", name: "v1" }, { kind: "tagDeleted", name: "v1", targetCommitId: "abc" }],
    [{ kind: "stashPop", id: "stash-id", restoreIndex: false }, { kind: "stashEntryConsumed", id: "stash-id", refName: "stash@{0}", title: "WIP", filesChanged: 2, base: "abc", branch: "main" }],
    [{ kind: "stashDrop", id: "stash-id" }, { kind: "stashEntryConsumed", id: "stash-id", refName: "stash@{0}", title: "WIP", filesChanged: 2, base: "abc", branch: "main" }],
    [{ kind: "checkoutDiscard", branch: "topic" }, { kind: "modifiedFilesDiscarded", count: 1, sample: ["a.txt"] }],
    [{ kind: "abortOperation" }, { kind: "stagedChangesDiscarded", count: 1 }],
    [{ kind: "recoveryRestore", commitId: "abc" }, { kind: "commitsUnreachable", count: 1, sample: [] }],
  ] as const)("renders the %s action through the shared dialog", async (requestedAction, consequence) => {
    render(
      <DestructivePreflightDialog
        repoId="repo-1"
        action={requestedAction}
        loadPreflight={vi.fn().mockResolvedValue(
          preflight(1, 1, [], "token", requestedAction, [consequence] as DestructivePreflight["consequences"]),
        )}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("dialog", { name: `preflight.${requestedAction.kind}.title` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `preflight.${requestedAction.kind}.confirm` })).toBeEnabled();
    const consequenceKey = consequence.kind === "branchDeleted" && consequence.unmergedInto
      ? "branchDeletedUnmerged"
      : consequence.kind === "stashEntryConsumed"
        ? requestedAction.kind === "stashDrop" ? "stashEntryDropped" : "stashEntryPopped"
        : consequence.kind;
    expect(screen.getByText(`preflight.consequences.${consequenceKey}${"count" in consequence ? `:${consequence.count}` : ""}`)).toBeInTheDocument();
  });

  it("renders Phase 9 blockers and disables confirmation", async () => {
    const blockedAction: DestructiveAction = { kind: "deleteBranch", name: "main" };
    render(
      <DestructivePreflightDialog
        repoId="repo-1"
        action={blockedAction}
        loadPreflight={vi.fn().mockResolvedValue(
          preflight(1, 0, ["current_branch_cannot_be_deleted"], null, blockedAction, []),
        )}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "preflight.blockers.current_branch_cannot_be_deleted",
    );
    expect(screen.getByRole("button", { name: "preflight.deleteBranch.confirm" })).toBeDisabled();
  });
});
