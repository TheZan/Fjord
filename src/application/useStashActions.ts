import { useCallback, useState } from "react";
import type { DestructiveAction, StashEntry } from "@/domain/git";
import { copiedStashValue, type StashAction } from "@/application/stashActions";

export interface StashOptionsState {
  action: "apply" | "pop";
  stash: StashEntry;
}

export interface StashBranchState {
  stash: StashEntry;
}

export function useStashActions({
  onApply,
  onDestructive,
  onCreateBranch,
  onRevealInGraph,
  onError,
}: {
  onApply: (stash: StashEntry, restoreIndex: boolean) => void | Promise<void>;
  onDestructive: (action: DestructiveAction, stash: StashEntry) => void;
  onCreateBranch: (stash: StashEntry, name: string, apply: boolean) => void | Promise<void>;
  onRevealInGraph: (stash: StashEntry) => void;
  onError: (error: unknown) => void;
}) {
  const [options, setOptions] = useState<StashOptionsState | null>(null);
  const [branch, setBranch] = useState<StashBranchState | null>(null);

  const dispatch = useCallback(async (action: StashAction, stash: StashEntry) => {
    if (action === "apply" || action === "pop") {
      setOptions({ action, stash });
      return;
    }
    if (action === "createBranch") {
      setBranch({ stash });
      return;
    }
    if (action === "drop") {
      onDestructive({ kind: "stashDrop", id: stash.id }, stash);
      return;
    }
    if (action === "revealInGraph") {
      onRevealInGraph(stash);
      return;
    }
    const value = copiedStashValue(action, stash);
    if (value === null) return;
    try {
      await navigator.clipboard?.writeText(value);
    } catch (error) {
      onError(error);
    }
  }, [onDestructive, onError, onRevealInGraph]);

  const confirmOptions = useCallback(async (restoreIndex: boolean) => {
    const selected = options;
    if (!selected) return;
    setOptions(null);
    if (selected.action === "pop") {
      onDestructive({
        kind: "stashPop",
        id: selected.stash.id,
        restoreIndex,
      }, selected.stash);
      return;
    }
    await onApply(selected.stash, restoreIndex);
  }, [onApply, onDestructive, options]);

  const confirmBranch = useCallback(async (name: string, apply: boolean) => {
    const selected = branch;
    if (!selected) return;
    setBranch(null);
    await onCreateBranch(selected.stash, name, apply);
  }, [branch, onCreateBranch]);

  return {
    dispatch,
    options,
    closeOptions: () => setOptions(null),
    confirmOptions,
    branch,
    closeBranch: () => setBranch(null),
    confirmBranch,
  };
}
