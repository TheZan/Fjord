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
): DestructivePreflight {
  return {
    action,
    consequences: [{ kind: "modifiedLinesDiscarded", path: "src/main.rs", count }],
    recoverable: "notRecoverable",
    blockers,
    generations: { workingTree, refs: 0, history: 0, stash: 0, config: 0 },
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
});
