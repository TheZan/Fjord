import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeDirtyPolicy, MergeMode, MergePreflight } from "@/domain/git";
import { MERGE_MESSAGE_LIMIT_BYTES, MergeDialog, mergeCreatesCommit, mergeMessageProblem, strategyOptionApplies } from "@/presentation/MergeDialog";

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
const remoteSource = { refName: "refs/remotes/origin/feature", kind: "remoteTracking" as const };

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
    expect(onConfirm).toHaveBeenCalledWith("fastForwardOnly", "refuse", false, false, null, null);
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("restates a fast-forward prediction as a merge commit once no-fast-forward is selected", () => {
    const onConfirm = vi.fn();
    render(
      <MergeDialog
        repoId="repo-1"
        source={source}
        currentBranch="main"
        pending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/merge\.prediction\.fastForward:/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("merge.mode.noFastForward"));
    // The prediction itself is unchanged; only the sentence the user reads is.
    expect(screen.getByText(/merge\.prediction\.fastForwardNoFf:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "merge.confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("noFastForward", "refuse", false, false, "Merge branch 'feature'", null);
  });

  it("offers fetch-before-merge for a remote-tracking source and names the known commit", () => {
    const onConfirm = vi.fn();
    mergeState.preflight = {
      ...preflight({ kind: "fastForward", commits: 2 }),
      source: remoteSource,
      sourceLabel: "origin/feature",
    };
    render(
      <MergeDialog
        repoId="repo-1"
        source={remoteSource}
        currentBranch="main"
        pending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText("merge.remote.knownCommit:sha=source-")).toBeInTheDocument();
    expect(screen.getByText("merge.remote.explanation")).toBeInTheDocument();
    const checkbox = screen.getByLabelText("merge.remote.fetchFirst:remote=origin");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "merge.confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("default", "refuse", true, false, null, null);
  });

  it("never offers fetch-before-merge for a local-branch source", () => {
    render(dialog(vi.fn()));
    expect(screen.queryByText(/merge\.remote\.fetchFirst/)).not.toBeInTheDocument();
    expect(screen.queryByText(/merge\.remote\.knownCommit/)).not.toBeInTheDocument();
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
    expect(onConfirm).toHaveBeenLastCalledWith("default", "stashFirst", false, false, null, null);
  });

  it("prefills the merge message from the preflight and submits the edited text", async () => {
    const onConfirm = vi.fn();
    mergeState.preflight = preflight({ kind: "mergeCommit", ahead: 2, behind: 1 });
    const { container } = renderDialog(onConfirm);

    const field = screen.getByLabelText("merge.message.label");
    expect(field).toHaveValue("Merge branch 'feature'");
    fireEvent.change(field, { target: { value: "Integrate feature\n\nWith a body." } });
    fireEvent.click(screen.getByRole("button", { name: "merge.confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(
      "default",
      "refuse",
      false,
      false,
      "Integrate feature\n\nWith a body.",
      null,
    );
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("hides the message field whenever no merge commit can result", () => {
    const onConfirm = vi.fn();
    // Default mode over a predicted fast-forward: no commit, no field.
    const { rerender } = renderDialog(onConfirm);
    expect(screen.queryByLabelText("merge.message.label")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("merge.mode.noFastForward"));
    expect(screen.getByLabelText("merge.message.label")).toHaveValue("Merge branch 'feature'");

    fireEvent.click(screen.getByLabelText("merge.mode.fastForwardOnly"));
    expect(screen.queryByLabelText("merge.message.label")).not.toBeInTheDocument();

    mergeState.preflight = preflight({ kind: "alreadyUpToDate" });
    rerender(dialog(onConfirm));
    expect(screen.queryByLabelText("merge.message.label")).not.toBeInTheDocument();

    mergeState.preflight = {
      ...preflight({ kind: "mergeCommit", ahead: 1, behind: 1 }),
      blockers: ["operation_already_in_progress"],
    };
    rerender(dialog(onConfirm));
    expect(screen.queryByLabelText("merge.message.label")).not.toBeInTheDocument();
  });

  it("keeps an untouched message in step with a refreshed preflight but never overwrites an edit", () => {
    const onConfirm = vi.fn();
    mergeState.preflight = preflight({ kind: "mergeCommit", ahead: 1, behind: 1 });
    const { rerender } = renderDialog(onConfirm);

    mergeState.preflight = {
      ...preflight({ kind: "mergeCommit", ahead: 1, behind: 1 }),
      defaultMessage: "Merge branch 'feature' into develop",
    };
    rerender(dialog(onConfirm));
    const field = screen.getByLabelText("merge.message.label");
    expect(field).toHaveValue("Merge branch 'feature' into develop");

    fireEvent.change(field, { target: { value: "My own message" } });
    mergeState.preflight = preflight({ kind: "mergeCommit", ahead: 2, behind: 1 });
    rerender(dialog(onConfirm));
    expect(screen.getByLabelText("merge.message.label")).toHaveValue("My own message");
  });

  it("refuses a blank or oversized message with an accessible reason", () => {
    const onConfirm = vi.fn();
    mergeState.preflight = preflight({ kind: "mergeCommit", ahead: 1, behind: 1 });
    renderDialog(onConfirm);
    const field = screen.getByLabelText("merge.message.label");
    const confirm = screen.getByRole("button", { name: "merge.confirm" });

    fireEvent.change(field, { target: { value: "   \n" } });
    expect(confirm).toBeDisabled();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("merge.message.empty");

    fireEvent.change(field, { target: { value: "x".repeat(MERGE_MESSAGE_LIMIT_BYTES + 1) } });
    expect(confirm).toBeDisabled();
    expect(field).toHaveAccessibleDescription("merge.message.tooLong");

    fireEvent.change(field, { target: { value: "Fine" } });
    expect(confirm).toBeEnabled();
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("shows the unrelated-histories acknowledgement only when required", () => {
    const onConfirm = vi.fn();
    mergeState.preflight = preflight({ kind: "unrelated" });
    const { rerender } = renderDialog(onConfirm);

    const acknowledgement = screen.getByLabelText("merge.unrelated.acknowledge");
    const confirm = screen.getByRole("button", { name: "merge.confirm" });
    expect(confirm).toBeDisabled();
    fireEvent.click(acknowledgement);
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("default", "refuse", false, true, "Merge branch 'feature'", null);

    mergeState.preflight = preflight({ kind: "mergeCommit", ahead: 1, behind: 1 });
    rerender(dialog(onConfirm));
    expect(screen.queryByLabelText("merge.unrelated.acknowledge")).not.toBeInTheDocument();
  });
});

function renderDialog(onConfirm: (
  mode: MergeMode,
  dirtyPolicy: MergeDirtyPolicy,
  fetchFirst: boolean,
  allowUnrelatedHistories: boolean,
  message: string | null,
) => void) {
  return render(dialog(onConfirm));
}

function dialog(onConfirm: (
  mode: MergeMode,
  dirtyPolicy: MergeDirtyPolicy,
  fetchFirst: boolean,
  allowUnrelatedHistories: boolean,
  message: string | null,
) => void) {
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
    defaultMessage: "Merge branch 'feature'",
    generations: { workingTree: 1, refs: 1, history: 1, stash: 0, config: 0 },
  };
}

describe("strategy option: Advanced disclosure (P12-MERGE-05)", () => {
  beforeEach(() => {
    mergeState.preflight = preflight({ kind: "mergeCommit", ahead: 1, behind: 1 });
    mergeState.loading = false;
    mergeState.error = null;
    mergeState.errorCode = null;
  });

  function renderDialog(onConfirm = vi.fn()) {
    return render(
      <MergeDialog
        repoId="repo-1"
        source={source}
        currentBranch="main"
        pending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
  }

  it("is collapsed and off by default, so a plain merge sends no option", () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);

    const toggle = screen.getByRole("button", { name: /merge\.advanced\.toggle/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("radio", { name: /merge\.advanced\.prefer/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "merge.confirm" }));
    expect(onConfirm).toHaveBeenCalledWith("default", "refuse", false, false, "Merge branch 'feature'", null);
  });

  it("names each option by its real ref and warns that the other side is discarded", async () => {
    const onConfirm = vi.fn();
    const { container } = renderDialog(onConfirm);

    fireEvent.click(screen.getByRole("button", { name: /merge\.advanced\.toggle/ }));
    expect(screen.getByRole("button", { name: /merge\.advanced\.toggle/ })).toHaveAttribute("aria-expanded", "true");
    const none = screen.getByRole("radio", { name: "merge.advanced.none" });
    expect(none).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "merge.advanced.prefer:ref=main" }));
    const warning = screen.getByRole("alert");
    expect(warning).toHaveTextContent("merge.advanced.warning:ref=main,other=feature");
    expect(screen.getByRole("button", { name: "merge.confirm" })).toHaveAttribute("aria-describedby", warning.id);
    expect((await axe.run(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "merge.confirm" }));
    expect(onConfirm).toHaveBeenLastCalledWith("default", "refuse", false, false, "Merge branch 'feature'", "preferTarget");

    fireEvent.click(screen.getByRole("radio", { name: "merge.advanced.prefer:ref=feature" }));
    expect(screen.getByRole("alert")).toHaveTextContent("merge.advanced.warning:ref=feature,other=main");
    fireEvent.click(screen.getByRole("button", { name: "merge.confirm" }));
    expect(onConfirm).toHaveBeenLastCalledWith("default", "refuse", false, false, "Merge branch 'feature'", "preferSource");
  });

  it("keeps the warning visible when Advanced is collapsed with an option chosen", () => {
    renderDialog();
    const toggle = screen.getByRole("button", { name: /merge\.advanced\.toggle/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("radio", { name: "merge.advanced.prefer:ref=feature" }));
    fireEvent.click(toggle);
    expect(screen.getByRole("alert")).toHaveTextContent("merge.advanced.warning");
  });

  it("is absent when no three-way merge can happen, and never sends a hidden option", () => {
    const onConfirm = vi.fn();
    renderDialog(onConfirm);
    fireEvent.click(screen.getByRole("button", { name: /merge\.advanced\.toggle/ }));
    fireEvent.click(screen.getByRole("radio", { name: "merge.advanced.prefer:ref=main" }));

    fireEvent.click(screen.getByLabelText("merge.mode.fastForwardOnly"));
    expect(screen.queryByRole("button", { name: /merge\.advanced\.toggle/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "merge.confirm" }));
    expect(onConfirm).toHaveBeenLastCalledWith("fastForwardOnly", "refuse", false, false, null, null);
  });

  it("applies only to a predicted merge commit or unrelated histories", () => {
    expect(strategyOptionApplies("mergeCommit", "default")).toBe(true);
    expect(strategyOptionApplies("mergeCommit", "noFastForward")).toBe(true);
    expect(strategyOptionApplies("unrelated", "default")).toBe(true);
    expect(strategyOptionApplies("mergeCommit", "fastForwardOnly")).toBe(false);
    expect(strategyOptionApplies("fastForward", "noFastForward")).toBe(false);
    expect(strategyOptionApplies("fastForward", "default")).toBe(false);
    expect(strategyOptionApplies("alreadyUpToDate", "default")).toBe(false);
  });
});

describe("merge message rules", () => {
  it("matches the backend: a commit results unless fast-forward-only or a predicted fast-forward", () => {
    expect(mergeCreatesCommit("fastForward", "default")).toBe(false);
    expect(mergeCreatesCommit("fastForward", "noFastForward")).toBe(true);
    expect(mergeCreatesCommit("mergeCommit", "default")).toBe(true);
    expect(mergeCreatesCommit("mergeCommit", "fastForwardOnly")).toBe(false);
    expect(mergeCreatesCommit("unrelated", "default")).toBe(true);
    expect(mergeCreatesCommit("alreadyUpToDate", "noFastForward")).toBe(false);
  });

  it("bounds the message in UTF-8 bytes after line-ending normalization", () => {
    expect(mergeMessageProblem("")).toBe("empty");
    expect(mergeMessageProblem("x".repeat(MERGE_MESSAGE_LIMIT_BYTES))).toBeNull();
    expect(mergeMessageProblem("é".repeat(MERGE_MESSAGE_LIMIT_BYTES / 2 + 1))).toBe("tooLong");
    expect(mergeMessageProblem("a\r\n".repeat(MERGE_MESSAGE_LIMIT_BYTES / 2))).toBeNull();
  });
});
