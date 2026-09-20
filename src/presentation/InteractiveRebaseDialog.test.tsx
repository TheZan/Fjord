import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveRebaseTodo, RebasePreflight, RebaseTodoStep } from "@/domain/git";
import { InteractiveRebaseDialog } from "@/presentation/InteractiveRebaseDialog";

const state = vi.hoisted(() => ({ todo: null as InteractiveRebaseTodo | null, loading: false, error: null as unknown, errorCode: null as string | null }));
vi.mock("@/application/useInteractiveRebase", () => ({ useInteractiveRebase: () => state }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key }) }));

const onto = { refName: "refs/heads/develop", kind: "localBranch" as const };
const preflight: RebasePreflight = {
  onto, ontoLabel: "develop", ontoCommit: "abc", currentBranch: "feature", currentCommit: "def",
  dirty: { staged: 0, modified: 0, untracked: 0, wouldOverwrite: [] }, blockers: [], commits: 2,
  alreadyUpToDate: false, publishedRewrite: null,
  generations: { workingTree: 1, refs: 1, history: 1, stash: 0, config: 0 },
};
function pickStep(commit: string, subject: string): RebaseTodoStep {
  return { commit, shortId: commit.slice(0, 7), subject, action: { kind: "pick" } };
}
function todo(): InteractiveRebaseTodo {
  return { preflight: structuredClone(preflight), steps: [pickStep("aaaaaaaaaa", "one"), pickStep("bbbbbbbbbb", "two")] };
}
function props() {
  return { repoId: "repo", onto, currentBranch: "feature", pending: false, executionError: null as string | null, onConfirm: vi.fn(), onCancel: vi.fn(), onClose: vi.fn() };
}
beforeEach(() => { state.todo = todo(); state.loading = false; state.error = null; state.errorCode = null; });

describe("InteractiveRebaseDialog", () => {
  it("lists every step as Pick and starts the rebase unchanged; passes an accessibility scan", async () => {
    const callbacks = props();
    const view = render(<InteractiveRebaseDialog {...callbacks} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName('rebase.todo.title:{"current":"feature","onto":"develop"}');
    expect(screen.getByText("one")).toBeVisible();
    expect(screen.getByText("two")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "rebase.todo.start" }));
    expect(callbacks.onConfirm).toHaveBeenCalledWith(state.todo!.preflight, state.todo!.steps, "refuse");
    expect((await axe.run(view.container)).violations).toEqual([]);
  });

  it("requires a message before a reword can be submitted, then submits the edited action", () => {
    const callbacks = props();
    render(<InteractiveRebaseDialog {...callbacks} />);
    const select = screen.getByRole("combobox", { name: 'rebase.todo.actionLabel:{"subject":"two"}' });
    fireEvent.change(select, { target: { value: "reword" } });
    expect(screen.getByRole("alert")).toHaveTextContent("rebase.todo.errors.emptyMessage");
    expect(screen.getByRole("button", { name: "rebase.todo.start" })).toBeDisabled();

    const message = screen.getByRole("textbox", { name: 'rebase.todo.messageLabel:{"subject":"two"}' });
    fireEvent.change(message, { target: { value: "new message" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "rebase.todo.start" }));
    expect(callbacks.onConfirm).toHaveBeenCalledWith(
      state.todo!.preflight,
      [pickStep("aaaaaaaaaa", "one"), { ...pickStep("bbbbbbbbbb", "two"), action: { kind: "reword", message: "new message" } }],
      "refuse",
    );
  });

  it("refuses a fixup on the first surviving step", () => {
    const callbacks = props();
    render(<InteractiveRebaseDialog {...callbacks} />);
    const select = screen.getByRole("combobox", { name: 'rebase.todo.actionLabel:{"subject":"one"}' });
    fireEvent.change(select, { target: { value: "fixup" } });
    expect(screen.getByRole("alert")).toHaveTextContent("rebase.todo.errors.firstIsFixupOrSquash");
    expect(screen.getByRole("button", { name: "rebase.todo.start" })).toBeDisabled();
  });

  it("offers explicit stash when the tree is dirty", () => {
    state.todo!.preflight.dirty = { staged: 1, modified: 0, untracked: 0, wouldOverwrite: [] };
    const callbacks = props();
    render(<InteractiveRebaseDialog {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "rebase.todo.stashAndStart" }));
    expect(callbacks.onConfirm).toHaveBeenCalledWith(state.todo!.preflight, state.todo!.steps, "stashFirst");
  });

  it("blocks on a hard preflight blocker", () => {
    state.todo!.preflight.blockers = ["detached_head"];
    render(<InteractiveRebaseDialog {...props()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("rebase.blocked.detached_head");
    expect(screen.getByRole("button", { name: "rebase.todo.start" })).toBeDisabled();
  });

  it("keeps cancellation available during execution and disables row controls", () => {
    const callbacks = props();
    render(<InteractiveRebaseDialog {...callbacks} pending progress="progress" />);
    expect(screen.getByRole("button", { name: "rebase.running" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("progress");
    fireEvent.click(screen.getByRole("button", { name: "rebase.cancelOperation" }));
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("combobox", { name: 'rebase.todo.actionLabel:{"subject":"one"}' })).toBeDisabled();
  });
});
