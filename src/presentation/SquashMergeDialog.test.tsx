import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MergePreflight } from "@/domain/git";
import { SquashMergeDialog } from "@/presentation/SquashMergeDialog";

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

describe("SquashMergeDialog", () => {
  beforeEach(() => {
    mergeState.preflight = preflight({ kind: "mergeCommit", ahead: 3, behind: 1 });
    mergeState.loading = false;
    mergeState.error = null;
    mergeState.errorCode = null;
  });

  it("names both refs, has no mode selector, and submits refuse by default", async () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <SquashMergeDialog
        repoId="repo-1"
        source={source}
        currentBranch="main"
        pending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("source=feature,target=main");
    expect(screen.getByText("squashMerge.explanation:source=feature,target=main")).toBeInTheDocument();
    expect(screen.queryByText(/merge\.mode\.label/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "squashMerge.confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("refuse");
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("renders already-up-to-date without a confirm button", () => {
    mergeState.preflight = preflight({ kind: "alreadyUpToDate" });
    render(
      <SquashMergeDialog
        repoId="repo-1"
        source={source}
        currentBranch="main"
        pending={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText(/merge\.prediction\.alreadyUpToDate/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "squashMerge.confirm" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "squashMerge.dismiss" })).toBeInTheDocument();
  });

  it("offers stash-and-squash-merge for a dirty tree and reports the blocker", () => {
    const onConfirm = vi.fn();
    mergeState.preflight = {
      ...preflight({ kind: "mergeCommit", ahead: 1, behind: 0 }),
      blockers: ["merge_would_overwrite"],
      dirty: { staged: 0, modified: 1, untracked: 0, wouldOverwrite: ["src/app.ts"] },
    };
    render(
      <SquashMergeDialog
        repoId="repo-1"
        source={source}
        currentBranch="main"
        pending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "squashMerge.dirty.stashAndSquashMerge" }));
    expect(onConfirm).toHaveBeenCalledWith("stashFirst");
  });

  it("renders a hard blocker instead of a confirm button", () => {
    mergeState.preflight = {
      ...preflight({ kind: "mergeCommit", ahead: 1, behind: 0 }),
      blockers: ["operation_already_in_progress"],
    };
    render(
      <SquashMergeDialog
        repoId="repo-1"
        source={source}
        currentBranch="main"
        pending={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("merge.blocked.operationInProgress:source=feature,target=main")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "squashMerge.confirm" })).not.toBeInTheDocument();
  });
});

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
