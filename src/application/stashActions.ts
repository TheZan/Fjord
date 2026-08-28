import type { StashEntry } from "@/domain/git";

export type StashAction =
  | "apply"
  | "pop"
  | "createBranch"
  | "copyRef"
  | "copySha"
  | "copyBaseSha"
  | "revealInGraph"
  | "drop";

export interface StashMenuItemDefinition {
  id: StashAction;
  labelKey: string;
  separatorBefore?: boolean;
  danger?: boolean;
}

/** One logical menu definition used by tree, graph, and inspector. */
export function buildStashMenuItems(canRevealInGraph: boolean): StashMenuItemDefinition[] {
  return [
    { id: "apply", labelKey: "stash.action.apply" },
    { id: "pop", labelKey: "stash.action.pop" },
    { id: "createBranch", labelKey: "stash.action.createBranch", separatorBefore: true },
    { id: "copyRef", labelKey: "stash.action.copyRef", separatorBefore: true },
    { id: "copySha", labelKey: "stash.action.copySha" },
    { id: "copyBaseSha", labelKey: "stash.action.copyBaseSha" },
    ...(canRevealInGraph
      ? [{ id: "revealInGraph" as const, labelKey: "stash.action.revealInGraph", separatorBefore: true }]
      : []),
    { id: "drop", labelKey: "stash.action.drop", separatorBefore: true, danger: true },
  ];
}

export function copiedStashValue(action: StashAction, stash: StashEntry): string | null {
  if (action === "copyRef") return stash.refName;
  if (action === "copySha") return stash.id;
  if (action === "copyBaseSha") return stash.base;
  return null;
}
