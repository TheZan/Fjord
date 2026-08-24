import { describe, expect, it } from "vitest";
import type { WorkingFileTarget } from "@/domain/git";
import {
  applyWorkingSelectionIntent,
  prepareWorkingContextSelection,
  reconcileWorkingSelection,
  workingTargetKey,
  type WorkingSelectionState,
} from "@/application/useWorkingFileSelection";

const a = target("a.ts", "worktree");
const b = target("b.ts", "worktree");
const c = target("c.ts", "worktree");
const d = target("d.ts", "worktree");
const stagedA = target("a.ts", "index");

describe("Working Changes selection transitions", () => {
  it("plain click selects exactly one logical target", () => {
    const selected = apply(empty(), a, [a, b], { toggle: false, range: false });
    const replaced = apply(selected, b, [a, b], { toggle: false, range: false });

    expect(keys(replaced)).toEqual([workingTargetKey(b)]);
    expect(replaced.active).toEqual(b);
    expect(replaced.anchor).toEqual(b);
  });

  it("Ctrl/Cmd click toggles independently and may leave an empty selection", () => {
    let state = apply(empty(), a, [a, b], { toggle: true, range: false });
    state = apply(state, b, [a, b], { toggle: true, range: false });
    expect(keys(state)).toEqual([workingTargetKey(a), workingTargetKey(b)]);

    state = apply(state, a, [a, b], { toggle: true, range: false });
    state = apply(state, b, [a, b], { toggle: true, range: false });
    expect(keys(state)).toEqual([]);
    expect(state.active).toEqual(b);
    expect(state.anchor).toEqual(b);
  });

  it("Shift ranges inclusively from the stable anchor in current visible order", () => {
    let state = apply(empty(), b, [a, b, c, d], { toggle: false, range: false });
    state = apply(state, d, [a, b, c, d], { toggle: false, range: true });
    expect(keys(state)).toEqual([workingTargetKey(b), workingTargetKey(c), workingTargetKey(d)]);

    state = apply(state, a, [a, b, c, d], { toggle: false, range: true });
    expect(keys(state)).toEqual([workingTargetKey(a), workingTargetKey(b)]);
    expect(state.anchor).toEqual(b);
  });

  it("Ctrl/Cmd+Shift adds the visible range to the current selection", () => {
    let state = apply(empty(), a, [a, b, c, d], { toggle: false, range: false });
    state = apply(state, d, [a, b, c, d], { toggle: true, range: false });
    state = apply(state, b, [a, b, c, d], { toggle: true, range: true });

    expect(keys(state)).toEqual([workingTargetKey(a), workingTargetKey(b), workingTargetKey(c), workingTargetKey(d)]);
  });

  it("keyboard toggle preserves the stable range anchor", () => {
    let state = apply(empty(), a, [a, b, c], { toggle: false, range: false });
    state = apply(state, c, [a, b, c], { toggle: false, range: true });
    state = apply(state, c, [], { toggle: true, range: false, preserveAnchor: true });

    expect(state.anchor).toEqual(a);
    expect(state.active).toEqual(c);
  });

  it("switching source clears and restarts for plain, toggle, and range intents", () => {
    for (const intent of [
      { toggle: false, range: false },
      { toggle: true, range: false },
      { toggle: false, range: true },
    ]) {
      const unstaged = apply(empty(), a, [a, b], { toggle: false, range: false });
      const staged = apply(unstaged, stagedA, [stagedA], intent);
      expect(keys(staged)).toEqual([workingTargetKey(stagedA)]);

      const back = apply(staged, b, [a, b], intent);
      expect(keys(back)).toEqual([workingTargetKey(b)]);
    }
  });

  it("uses only the supplied visible file order for a tree range", () => {
    const hidden = target("collapsed/hidden.ts", "worktree");
    const visibleOrder = [a, c, d];
    let state = apply(empty(), a, visibleOrder, { toggle: false, range: false });
    state = apply(state, d, visibleOrder, { toggle: false, range: true });

    expect(keys(state)).toEqual(visibleOrder.map(workingTargetKey));
    expect(state.targetKeys.has(workingTargetKey(hidden))).toBe(false);
  });

  it("right-click preserves an inside selection and replaces it outside", () => {
    let state = apply(empty(), a, [a, b, c], { toggle: false, range: false });
    state = apply(state, c, [a, b, c], { toggle: true, range: false });

    const inside = prepareWorkingContextSelection(state, "repo-1", a);
    expect(keys(inside)).toEqual([workingTargetKey(a), workingTargetKey(c)]);
    expect(inside.active).toEqual(a);

    const outside = prepareWorkingContextSelection(inside, "repo-1", b);
    expect(keys(outside)).toEqual([workingTargetKey(b)]);
    expect(outside.anchor).toEqual(b);
  });

  it("drops ghost targets, moves active to a surviving selection, and clears on repository switch", () => {
    let state = apply(empty(), a, [a, b, c], { toggle: false, range: false });
    state = apply(state, b, [a, b, c], { toggle: true, range: false });
    const reconciled = reconcileWorkingSelection(
      state,
      "repo-1",
      [a],
      [a, b, c].map(workingTargetKey),
    );
    expect(keys(reconciled)).toEqual([workingTargetKey(a)]);
    expect(reconciled.active).toEqual(a);

    expect(reconcileWorkingSelection(
      reconciled,
      "repo-2",
      [a],
      [workingTargetKey(a)],
    )).toEqual(empty("repo-2"));
  });

  it("distinguishes the same path on index and worktree by logical identity", () => {
    expect(workingTargetKey(a)).not.toBe(workingTargetKey(stagedA));
  });
});

function target(path: string, source: WorkingFileTarget["source"]): WorkingFileTarget {
  return { path, source };
}

function empty(repositoryId = "repo-1"): WorkingSelectionState {
  return {
    repositoryId,
    targetKeys: new Set(),
    source: null,
    active: null,
    anchor: null,
  };
}

function apply(
  state: WorkingSelectionState,
  selected: WorkingFileTarget,
  visible: WorkingFileTarget[],
  intent: { toggle: boolean; range: boolean; preserveAnchor?: boolean },
) {
  return applyWorkingSelectionIntent(state, "repo-1", selected, visible, intent);
}

function keys(state: WorkingSelectionState) {
  return [...state.targetKeys].sort();
}
