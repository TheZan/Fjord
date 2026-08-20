import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeDirtyPolicy, MergeMode, MergePreflight } from "@/domain/git";
import { MergeDialog } from "@/presentation/MergeDialog";

const mergeState = vi.hoisted(() => ({
  preflight: null as MergePreflight | null,
  loading: false,
  error: null as string | null,
  errorCode: null as string | null,
}));

vi.mock("@/application/useMergeBranch", () => ({
  useMergeBranch: () => mergeState,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const serialized = values
        ? Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")
        : "";
      return serialized ? `${key}:${serialized}` : key;
    },
  }),
}));

const source = { refName: "refs/heads/feature", kind: "localBranch" as const };

describe("MergeDialog", () => {
  beforeEach(() => {
    mergeState.preflight = preflight({ kind: "fastForward", commits: 2 });
    mergeState.loading = false;
    mergeState.error = null;
    mergeState.errorCode = null;
  });

  it("names both refs, describes fast-forward, and submits the selected mode", async () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <MergeDialog
        repoId="repo-1"
        source={source}
        currentBranch="main"
        pending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("source=feature,target=main");
    expect(screen.getByText(/merge\.prediction\.fastForward/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("merge.mode.fastForwardOnly"));
    fireEvent.click(screen.getByRole("button", { name: "merge.confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("fastForwardOnly", "refuse");
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("renders already-up-to-date, merge-commit, and dirty choices distinctly", () => {
    const onConfirm = vi.fn();
    mergeState.preflight = preflight({ kind: "alreadyUpToDate" });
    const { rerender } = renderDialog(onConfirm);
    expect(screen.getByText(/merge\.prediction\.alreadyUpToDate/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "merge.confirm" })).not.toBeInTheDocument();

    mergeState.preflight = preflight({ kind: "mergeCommit", ahead: 3, behind: 1 });
    rerender(dialog(onConfirm));
    expect(screen.getByText(/merge\.prediction\.mergeCommit/)).toBeInTheDocument();

    mergeState.preflight = {
      ...preflight({ kind: "fastForward", commits: 1 }),
      blockers: ["merge_index_has_staged_changes"],
      dirty: { staged: 2, modified: 1, untracked: 0, wouldOverwrite: [] },
    };
    rerender(dialog(onConfirm));
    fireEvent.click(screen.getByRole("button", { name: "merge.dirty.stashAndMerge" }));
    expect(onConfirm).toHaveBeenLastCalledWith("default", "stashFirst");
  });
});

function renderDialog(onConfirm: (mode: MergeMode, dirtyPolicy: MergeDirtyPolicy) => void) {
  return render(dialog(onConfirm));
}

function dialog(onConfirm: (mode: MergeMode, dirtyPolicy: MergeDirtyPolicy) => void) {
  return (
    <MergeDialog
      repoId="repo-1"
      source={source}
      currentBranch="main"
      pending={false}
      onClose={vi.fn()}
      onConfirm={onConfirm}
    />
  );
}

function preflight(prediction: MergePreflight["prediction"]): MergePreflight {
  return {
    source,
    sourceLabel: "feature",
    sourceCommit: "source-commit",
    targetBranch: "main",
    targetCommit: "target-commit",
    prediction,
    dirty: { staged: 0, modified: 0, untracked: 0, wouldOverwrite: [] },
    blockers: [],
    generations: { workingTree: 1, refs: 1, history: 1, stash: 0, config: 0 },
  };
}
