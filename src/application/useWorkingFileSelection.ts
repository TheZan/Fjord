import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PatchSource, WorkingChanges, WorkingFileTarget } from "@/domain/git";

interface FileSelectionIntent {
  toggle: boolean;
  range: boolean;
  preserveAnchor?: boolean;
}

export interface WorkingSelection {
  /** Canonical targets for future batch actions. Identity is source + path. */
  targets: ReadonlySet<WorkingFileTarget>;
  active: WorkingFileTarget | null;
  anchor: WorkingFileTarget | null;
}

export interface WorkingSelectionState {
  repositoryId: string;
  targetKeys: ReadonlySet<string>;
  source: PatchSource | null;
  active: WorkingFileTarget | null;
  anchor: WorkingFileTarget | null;
}

export interface WorkingFileSelectionController extends WorkingSelection {
  isSelected: (target: WorkingFileTarget) => boolean;
  select: (
    target: WorkingFileTarget,
    visibleTargets: readonly WorkingFileTarget[],
    intent: FileSelectionIntent,
  ) => void;
  selectAll: (
    source: PatchSource,
    visibleTargets: readonly WorkingFileTarget[],
    focusedTarget: WorkingFileTarget,
  ) => void;
  activate: (target: WorkingFileTarget) => void;
  prepareContextMenu: (target: WorkingFileTarget) => void;
  registerVisibleTargets: (
    source: PatchSource,
    visibleTargets: readonly WorkingFileTarget[],
  ) => void;
  clear: () => void;
}

const TARGET_KEY_SEPARATOR = "\0";

export function workingTargetKey(target: WorkingFileTarget): string {
  return `${target.source}${TARGET_KEY_SEPARATOR}${target.path}`;
}

function sameTarget(left: WorkingFileTarget | null, right: WorkingFileTarget | null) {
  return left === right
    || (left !== null
      && right !== null
      && left.path === right.path
      && left.source === right.source);
}

function emptySelection(repositoryId: string): WorkingSelectionState {
  return { repositoryId, targetKeys: new Set(), source: null, active: null, anchor: null };
}

function withRepository(
  state: WorkingSelectionState,
  repositoryId: string,
): WorkingSelectionState {
  return state.repositoryId === repositoryId ? state : emptySelection(repositoryId);
}

export function applyWorkingSelectionIntent(
  state: WorkingSelectionState,
  repositoryId: string,
  target: WorkingFileTarget,
  visibleTargets: readonly WorkingFileTarget[],
  intent: FileSelectionIntent,
): WorkingSelectionState {
  const current = withRepository(state, repositoryId);
  const targetKey = workingTargetKey(target);
  const crossesSection = current.source !== null && current.source !== target.source;

  if (crossesSection || (!intent.toggle && !intent.range)) {
    return {
      repositoryId,
      targetKeys: new Set([targetKey]),
      source: target.source,
      active: target,
      anchor: target,
    };
  }

  if (!intent.range) {
    const nextKeys = new Set(current.targetKeys);
    if (nextKeys.has(targetKey)) nextKeys.delete(targetKey);
    else nextKeys.add(targetKey);
    return {
      repositoryId,
      targetKeys: nextKeys,
      source: nextKeys.size > 0 ? target.source : null,
      active: target,
      anchor: intent.preserveAnchor ? current.anchor ?? target : target,
    };
  }

  const anchor = current.anchor;
  const anchorIndex = anchor?.source === target.source
    ? visibleTargets.findIndex((candidate) => sameTarget(candidate, anchor))
    : -1;
  const targetIndex = visibleTargets.findIndex((candidate) => sameTarget(candidate, target));
  if (anchorIndex < 0 || targetIndex < 0) {
    return {
      repositoryId,
      targetKeys: new Set([targetKey]),
      source: target.source,
      active: target,
      anchor: target,
    };
  }

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const nextKeys = intent.toggle ? new Set(current.targetKeys) : new Set<string>();
  for (let index = start; index <= end; index += 1) {
    nextKeys.add(workingTargetKey(visibleTargets[index]));
  }
  return {
    repositoryId,
    targetKeys: nextKeys,
    source: target.source,
    active: target,
    anchor,
  };
}

export function prepareWorkingContextSelection(
  state: WorkingSelectionState,
  repositoryId: string,
  target: WorkingFileTarget,
): WorkingSelectionState {
  const current = withRepository(state, repositoryId);
  const key = workingTargetKey(target);
  if (current.targetKeys.has(key)) {
    return { ...current, active: target };
  }
  return {
    repositoryId,
    targetKeys: new Set([key]),
    source: target.source,
    active: target,
    anchor: target,
  };
}

export function reconcileWorkingSelection(
  state: WorkingSelectionState,
  repositoryId: string,
  availableTargets: readonly WorkingFileTarget[],
  previousOrder: readonly string[],
): WorkingSelectionState {
  const current = withRepository(state, repositoryId);
  if (current !== state) return current;

  const available = new Map(availableTargets.map((target) => [workingTargetKey(target), target]));
  const targetKeys = new Set([...current.targetKeys].filter((key) => available.has(key)));
  let active = current.active ? available.get(workingTargetKey(current.active)) ?? null : null;
  let anchor = current.anchor ? available.get(workingTargetKey(current.anchor)) ?? null : null;

  if (!active && targetKeys.size > 0) {
    const oldActiveIndex = current.active
      ? previousOrder.indexOf(workingTargetKey(current.active))
      : -1;
    const candidates = [...targetKeys];
    candidates.sort((left, right) => {
      if (oldActiveIndex < 0) {
        return availableTargets.findIndex((target) => workingTargetKey(target) === left)
          - availableTargets.findIndex((target) => workingTargetKey(target) === right);
      }
      const leftIndex = previousOrder.indexOf(left);
      const rightIndex = previousOrder.indexOf(right);
      return Math.abs(leftIndex - oldActiveIndex) - Math.abs(rightIndex - oldActiveIndex);
    });
    active = available.get(candidates[0]) ?? null;
  }
  if (targetKeys.size === 0) {
    active = active && available.has(workingTargetKey(active)) ? active : null;
    anchor = anchor && available.has(workingTargetKey(anchor)) ? anchor : null;
  }

  const unchanged = targetKeys.size === current.targetKeys.size
    && [...targetKeys].every((key) => current.targetKeys.has(key))
    && sameTarget(active, current.active)
    && sameTarget(anchor, current.anchor);
  const source = targetKeys.size > 0 ? current.source : null;
  return unchanged ? state : { repositoryId, targetKeys, source, active, anchor };
}

function targetsForChanges(changes: WorkingChanges): WorkingFileTarget[] {
  return [
    ...changes.unstaged.map((file) => ({ path: file.path, source: "worktree" as const })),
    ...changes.staged.map((file) => ({ path: file.path, source: "index" as const })),
  ];
}

export function useWorkingFileSelection(
  repositoryId: string,
  changes: WorkingChanges,
): WorkingFileSelectionController {
  const availableTargets = useMemo(() => targetsForChanges(changes), [changes]);
  const availableByKey = useMemo(
    () => new Map(availableTargets.map((target) => [workingTargetKey(target), target])),
    [availableTargets],
  );
  const previousOrder = useRef<string[]>(availableTargets.map(workingTargetKey));
  const [state, setState] = useState<WorkingSelectionState>(() => emptySelection(repositoryId));

  useEffect(() => {
    setState((current) => reconcileWorkingSelection(
      current,
      repositoryId,
      availableTargets,
      previousOrder.current,
    ));
    previousOrder.current = availableTargets.map(workingTargetKey);
  }, [availableTargets, repositoryId]);

  const select = useCallback((
    target: WorkingFileTarget,
    visibleTargets: readonly WorkingFileTarget[],
    intent: FileSelectionIntent,
  ) => {
    setState((current) => applyWorkingSelectionIntent(
      current,
      repositoryId,
      target,
      visibleTargets,
      intent,
    ));
  }, [repositoryId]);

  const selectAll = useCallback((
    source: PatchSource,
    visibleTargets: readonly WorkingFileTarget[],
    focusedTarget: WorkingFileTarget,
  ) => {
    setState((stateBeforeUpdate) => {
      const current = withRepository(stateBeforeUpdate, repositoryId);
      const sourceTargets = visibleTargets.filter((target) => target.source === source);
      if (sourceTargets.length === 0) return current;
      const anchor = current.anchor?.source === source
        && sourceTargets.some((target) => sameTarget(target, current.anchor))
        ? current.anchor
        : focusedTarget;
      return {
        repositoryId,
        targetKeys: new Set(sourceTargets.map(workingTargetKey)),
        source,
        active: focusedTarget,
        anchor,
      };
    });
  }, [repositoryId]);

  const activate = useCallback((target: WorkingFileTarget) => {
    setState((stateBeforeUpdate) => {
      const current = withRepository(stateBeforeUpdate, repositoryId);
      return sameTarget(current.active, target) ? current : { ...current, active: target };
    });
  }, [repositoryId]);

  const prepareContextMenu = useCallback((target: WorkingFileTarget) => {
    setState((current) => prepareWorkingContextSelection(current, repositoryId, target));
  }, [repositoryId]);

  const registerVisibleTargets = useCallback((
    source: PatchSource,
    visibleTargets: readonly WorkingFileTarget[],
  ) => {
    setState((stateBeforeUpdate) => {
      const current = withRepository(stateBeforeUpdate, repositoryId);
      if (!current.anchor || current.anchor.source !== source) return current;
      if (visibleTargets.some((target) => sameTarget(target, current.anchor))) return current;
      return { ...current, anchor: null };
    });
  }, [repositoryId]);

  const clear = useCallback(() => setState(emptySelection(repositoryId)), [repositoryId]);
  const stateMatchesRepository = state.repositoryId === repositoryId;
  const effectiveTargetKeys = stateMatchesRepository ? state.targetKeys : new Set<string>();
  const active = stateMatchesRepository && state.active
    ? availableByKey.get(workingTargetKey(state.active)) ?? null
    : null;
  const anchor = stateMatchesRepository && state.anchor
    ? availableByKey.get(workingTargetKey(state.anchor)) ?? null
    : null;
  const isSelected = useCallback(
    (target: WorkingFileTarget) => effectiveTargetKeys.has(workingTargetKey(target)),
    [effectiveTargetKeys],
  );
  const targets = useMemo<ReadonlySet<WorkingFileTarget>>(
    () => new Set([...effectiveTargetKeys].flatMap((key) => {
      const target = availableByKey.get(key);
      return target ? [target] : [];
    })),
    [availableByKey, effectiveTargetKeys],
  );

  return {
    targets,
    active,
    anchor,
    isSelected,
    select,
    selectAll,
    activate,
    prepareContextMenu,
    registerVisibleTargets,
    clear,
  };
}
