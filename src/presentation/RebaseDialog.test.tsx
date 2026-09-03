import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RebasePreflight } from "@/domain/git";
import { RebaseDialog } from "@/presentation/RebaseDialog";

const state = vi.hoisted(() => ({ preflight: null as RebasePreflight | null, loading: false, error: null as unknown, errorCode: null as string | null }));
vi.mock("@/application/useRebaseBranch", () => ({ useRebaseBranch: () => state }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key }) }));
const onto = { refName: "refs/heads/develop", kind: "localBranch" as const };
const facts: RebasePreflight = {
  onto, ontoLabel: "develop", ontoCommit: "abc", currentBranch: "feature", currentCommit: "def",
  dirty: { staged: 0, modified: 0, untracked: 0, wouldOverwrite: [] }, blockers: [], commits: 4,
  alreadyUpToDate: false, publishedRewrite: null,
  generations: { workingTree: 1, refs: 1, history: 1, stash: 0, config: 0 },
};
function props() { return { repoId: "repo", onto, currentBranch: "feature", pending: false, executionError: null as string | null, onConfirm: vi.fn(), onCancel: vi.fn(), onClose: vi.fn() }; }
beforeEach(() => { state.preflight = structuredClone(facts); state.loading = false; state.error = null; state.errorCode = null; });

describe("RebaseDialog", () => {
  it("names the direction and submits the exact displayed facts; traps and restores focus", async () => {
    const invoker = document.createElement("button"); document.body.append(invoker); invoker.focus();
    const callbacks = props(); const view = render(<RebaseDialog {...callbacks} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName('rebase.title:{"current":"feature","onto":"develop"}');
    const cancel = screen.getByRole("button", { name: "merge.cancel" }); expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    const confirm = screen.getByRole("button", { name: "rebase.confirm" }); expect(confirm).toHaveFocus();
    fireEvent.click(confirm); expect(callbacks.onConfirm).toHaveBeenCalledWith(state.preflight, "refuse");
    fireEvent.keyDown(confirm, { key: "Escape" }); expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect((await axe.run(view.container)).violations).toEqual([]);
    view.unmount(); expect(invoker).toHaveFocus(); invoker.remove();
  });
  it.each(["operation_already_in_progress", "detached_head", "unborn_head", "target_is_current_branch", "target_not_found", "target_unsupported"] as const)("blocks %s", (code) => {
    state.preflight!.blockers = [code]; const callbacks = props(); render(<RebaseDialog {...callbacks} />);
    expect(screen.getByRole("alert")).toHaveTextContent(`rebase.blocked.${code}`);
    expect(screen.getByRole("button", { name: "rebase.confirm" })).toBeDisabled();
  });
  it.each(["index_has_staged_changes", "would_overwrite"] as const)("offers explicit stash for %s with bounded paths", (code) => {
    state.preflight!.blockers = [code]; state.preflight!.dirty = { staged: 1, modified: 1, untracked: 1, wouldOverwrite: ["important.txt"] };
    const callbacks = props(); render(<RebaseDialog {...callbacks} />);
    expect(screen.getByText("important.txt")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "rebase.stashAndRebase" }));
    expect(callbacks.onConfirm).toHaveBeenCalledWith(state.preflight, "stashFirst");
  });
  it("shows exact published count and no confirm for no-op", () => {
    state.preflight!.publishedRewrite = { upstream: "refs/remotes/origin/feature", commits: 2 };
    const callbacks = props(); const view = render(<RebaseDialog {...callbacks} />);
    expect(screen.getByText('rebase.published:{"count":2}')).toBeVisible();
    state.preflight = { ...facts, alreadyUpToDate: true, commits: 0 }; view.rerender(<RebaseDialog {...callbacks} />);
    expect(screen.queryByRole("button", { name: "rebase.confirm" })).not.toBeInTheDocument();
  });
  it("disables confirmation while refreshed generations are loading, then uses the new facts", () => {
    const callbacks = props(); const view = render(<RebaseDialog {...callbacks} />);
    state.loading = true; view.rerender(<RebaseDialog {...callbacks} />);
    expect(screen.getByRole("button", { name: "rebase.confirm" })).toBeDisabled();
    state.loading = false; state.preflight = { ...facts, ontoCommit: "changed", commits: 6, generations: { ...facts.generations, refs: 2 } };
    view.rerender(<RebaseDialog {...callbacks} />); fireEvent.click(screen.getByRole("button", { name: "rebase.confirm" }));
    expect(callbacks.onConfirm).toHaveBeenCalledWith(state.preflight, "refuse");
  });
  it("keeps cancellation available during execution, does not dismiss on Escape, and displays errors", () => {
    const callbacks = props(); const view = render(<RebaseDialog {...callbacks} pending progress="progress" />);
    expect(screen.getByRole("button", { name: "rebase.running" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); expect(callbacks.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "rebase.cancelOperation" })); expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("progress");
    view.rerender(<RebaseDialog {...callbacks} executionError="retained stash@{3}" />);
    expect(screen.getByRole("alert")).toHaveTextContent("retained stash@{3}");
  });
  it.each(["integration_detached_head", "integration_unborn_head", "integration_target_not_found"])("renders typed read failure %s and refuses stale cached data", (code) => {
    state.error = new Error("read failed"); state.errorCode = code;
    render(<RebaseDialog {...props()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(code.replace("integration_", "rebase.blocked."));
    expect(screen.getByRole("button", { name: "rebase.confirm" })).toBeDisabled();
  });
});
