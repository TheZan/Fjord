import { describe, expect, it } from "vitest";
import type { WorkingFileTarget } from "@/domain/git";
import {
  WorkingSelectionModel,
  applyWorkingSelectionIntent,
  prepareWorkingContextSelection,
  reconcileWorkingSelection,
  workingTargetKey,
} from "@/application/useWorkingFileSelection";

const a = target("a.ts", "worktree");
const b = target("b.ts", "worktree");
const c = target("c.ts", "worktree");
const d = target("d.ts", "worktree");
const stagedA = target("a.ts", "index");

describe("Working Changes selection transitions", () => {
  it("plain click selects exactly one logical target", () => {
    const model = createModel();
    apply(model, a, [a, b], { toggle: false, range: false });
    apply(model, b, [a, b], { toggle: false, range: false });

    expect(keys(model)).toEqual([workingTargetKey(b)]);
    expect(model.active).toEqual(b);
    expect(model.anchor).toEqual(b);
  });

  it("Ctrl/Cmd click toggles independently and may leave an empty selection", () => {
    const model = createModel();
    apply(model, a, [a, b], { toggle: true, range: false });
    apply(model, b, [a, b], { toggle: true, range: false });
    expect(keys(model)).toEqual([workingTargetKey(a), workingTargetKey(b)]);

    apply(model, a, [a, b], { toggle: true, range: false });
    apply(model, b, [a, b], { toggle: true, range: false });
    expect(keys(model)).toEqual([]);
    expect(model.active).toEqual(b);
    expect(model.anchor).toEqual(b);
  });

  it("toggles one target in a large selection without replacing the key store", () => {
    const model = createModel();
    const largeSelection = Array.from({ length: 10_000 }, (_, index) => (
      target(`src/file-${index}.ts`, "worktree")
    ));
    model.selectAll("repo-1", "worktree", largeSelection, largeSelection[0]);
    const toggled = largeSelection[5_000];

    apply(model, toggled, [], { toggle: true, range: false });

    expect(model.size).toBe(9_999);
    expect(model.has(toggled)).toBe(false);
    expect(model.has(largeSelection[0])).toBe(true);
    expect(model.has(largeSelection.at(-1)!)).toBe(true);
  });

  it("Shift ranges inclusively from the stable anchor in current visible order", () => {
    const model = createModel();
    apply(model, b, [a, b, c, d], { toggle: false, range: false });
    apply(model, d, [a, b, c, d], { toggle: false, range: true });
    expect(keys(model)).toEqual([workingTargetKey(b), workingTargetKey(c), workingTargetKey(d)]);

    apply(model, a, [a, b, c, d], { toggle: false, range: true });
    expect(keys(model)).toEqual([workingTargetKey(a), workingTargetKey(b)]);
    expect(model.anchor).toEqual(b);
  });

  it("Ctrl/Cmd+Shift adds the visible range to the current selection", () => {
    const model = createModel();
    apply(model, a, [a, b, c, d], { toggle: false, range: false });
    apply(model, d, [a, b, c, d], { toggle: true, range: false });
    apply(model, b, [a, b, c, d], { toggle: true, range: true });

    expect(keys(model)).toEqual([workingTargetKey(a), workingTargetKey(b), workingTargetKey(c), workingTargetKey(d)]);
  });

  it("keyboard toggle preserves the stable range anchor", () => {
    const model = createModel();
    apply(model, a, [a, b, c], { toggle: false, range: false });
    apply(model, c, [a, b, c], { toggle: false, range: true });
    apply(model, c, [], { toggle: true, range: false, preserveAnchor: true });

    expect(model.anchor).toEqual(a);
    expect(model.active).toEqual(c);
  });

  it("switching source clears and restarts for plain, toggle, and range intents", () => {
    for (const intent of [
      { toggle: false, range: false },
      { toggle: true, range: false },
      { toggle: false, range: true },
    ]) {
      const model = createModel();
      apply(model, a, [a, b], { toggle: false, range: false });
      apply(model, stagedA, [stagedA], intent);
      expect(keys(model)).toEqual([workingTargetKey(stagedA)]);

      apply(model, b, [a, b], intent);
      expect(keys(model)).toEqual([workingTargetKey(b)]);
    }
  });

  it("uses only the supplied visible file order for a tree range", () => {
    const hidden = target("collapsed/hidden.ts", "worktree");
    const visibleOrder = [a, c, d];
    const model = createModel();
    apply(model, a, visibleOrder, { toggle: false, range: false });
    apply(model, d, visibleOrder, { toggle: false, range: true });

    expect(keys(model)).toEqual(visibleOrder.map(workingTargetKey));
    expect(model.has(hidden)).toBe(false);
  });

  it("right-click preserves an inside selection and replaces it outside", () => {
    const model = createModel();
    apply(model, a, [a, b, c], { toggle: false, range: false });
    apply(model, c, [a, b, c], { toggle: true, range: false });

    prepareWorkingContextSelection(model, "repo-1", a);
    expect(keys(model)).toEqual([workingTargetKey(a), workingTargetKey(c)]);
    expect(model.active).toEqual(a);

    prepareWorkingContextSelection(model, "repo-1", b);
    expect(keys(model)).toEqual([workingTargetKey(b)]);
    expect(model.anchor).toEqual(b);
  });

  it("drops ghost targets, moves active to a surviving selection, and clears on repository switch", () => {
    const model = createModel();
    apply(model, a, [a, b, c], { toggle: false, range: false });
    apply(model, b, [a, b, c], { toggle: true, range: false });
    reconcileWorkingSelection(model, "repo-1", [a], [a, b, c].map(workingTargetKey));
    expect(keys(model)).toEqual([workingTargetKey(a)]);
    expect(model.active).toEqual(a);

    reconcileWorkingSelection(model, "repo-2", [a], [workingTargetKey(a)]);
    expect(model.repositoryId).toBe("repo-2");
    expect(model.size).toBe(0);
    expect(model.active).toBeNull();
    expect(model.anchor).toBeNull();
  });

  it("uses the old display order to choose the nearest selected survivor", () => {
    const e = target("e.ts", "worktree");
    const previousOrder = [a, b, c, d, e];
    const model = createModel();
    // Insertion order starts with A, but D is nearest to the disappearing C.
    apply(model, a, previousOrder, { toggle: false, range: false });
    apply(model, d, previousOrder, { toggle: true, range: false });
    apply(model, c, previousOrder, { toggle: true, range: false });

    reconcileWorkingSelection(
      model,
      "repo-1",
      [a, b, d, e],
      previousOrder.map(workingTargetKey),
    );

    expect(keys(model)).toEqual([workingTargetKey(a), workingTargetKey(d)]);
    expect(model.active).toEqual(d);
  });

  it("exposes read-only target and path views", () => {
    const model = createModel();
    apply(model, a, [a], { toggle: false, range: false });
    const targets = model.targetsView("repo-1", new Map([[workingTargetKey(a), a]]));
    const paths = model.selectedPathsView("repo-1", "worktree");

    expect([...targets]).toEqual([a]);
    expect([...paths]).toEqual([a.path]);
    expect("add" in targets).toBe(false);
    expect("delete" in paths).toBe(false);
  });

  it("distinguishes the same path on index and worktree by logical identity", () => {
    expect(workingTargetKey(a)).not.toBe(workingTargetKey(stagedA));
  });
});

function target(path: string, source: WorkingFileTarget["source"]): WorkingFileTarget {
  return { path, source };
}

function createModel() {
  return new WorkingSelectionModel("repo-1");
}

function apply(
  model: WorkingSelectionModel,
  selected: WorkingFileTarget,
  visible: WorkingFileTarget[],
  intent: { toggle: boolean; range: boolean; preserveAnchor?: boolean },
) {
  applyWorkingSelectionIntent(model, "repo-1", selected, visible, intent);
  return model;
}

function keys(model: WorkingSelectionModel) {
  return [...model.selectedKeys()].sort();
}
