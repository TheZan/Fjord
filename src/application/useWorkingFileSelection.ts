import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { PatchSource, WorkingChanges, WorkingFileTarget } from "@/domain/git";

interface FileSelectionIntent {
  toggle: boolean;
  range: boolean;
  preserveAnchor?: boolean;
}

export interface WorkingSelection {
  /** Read-only live view. Canonical identity is source + path. */
  targets: ReadonlySet<WorkingFileTarget>;
  active: WorkingFileTarget | null;
  anchor: WorkingFileTarget | null;
}

export interface WorkingFileSelectionController extends WorkingSelection {
  source: PatchSource | null;
  isSelected: (target: WorkingFileTarget) => boolean;
  selectedPaths: (source: PatchSource) => ReadonlySet<string>;
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
  beginSourceRemap: (
    targets: readonly WorkingFileTarget[],
    destination: PatchSource,
  ) => boolean;
  completeSourceRemap: (succeeded: boolean) => void;
}

const TARGET_KEY_SEPARATOR = "\0";

export function workingTargetKey(target: WorkingFileTarget): string {
  return `${target.source}${TARGET_KEY_SEPARATOR}${target.path}`;
}

function pathFromTargetKey(key: string): string {
  return key.slice(key.indexOf(TARGET_KEY_SEPARATOR) + 1);
}

function sameTarget(left: WorkingFileTarget | null, right: WorkingFileTarget | null) {
  return left === right
    || (left !== null
      && right !== null
      && left.path === right.path
      && left.source === right.source);
}

/**
 * Canonical DOM-free selection storage. Single-target toggle mutates only one
 * hash-set entry; React receives a separate revision notification.
 */
export class WorkingSelectionModel {
  readonly #targetKeys = new Set<string>();

  repositoryId: string;
  source: PatchSource | null = null;
  active: WorkingFileTarget | null = null;
  anchor: WorkingFileTarget | null = null;
  pendingSourceRemap: {
    repositoryId: string;
    paths: readonly string[];
    from: PatchSource;
    to: PatchSource;
    activePath: string | null;
    anchorPath: string | null;
  } | null = null;

  constructor(repositoryId: string) {
    this.repositoryId = repositoryId;
  }

  get size() {
    return this.#targetKeys.size;
  }

  has(target: WorkingFileTarget) {
    return this.#targetKeys.has(workingTargetKey(target));
  }

  selectedKeys(): IterableIterator<string> {
    return this.#targetKeys.values();
  }

  select(
    repositoryId: string,
    target: WorkingFileTarget,
    visibleTargets: readonly WorkingFileTarget[],
    intent: FileSelectionIntent,
  ) {
    this.ensureRepository(repositoryId);
    const targetKey = workingTargetKey(target);
    const crossesSection = this.source !== null && this.source !== target.source;

    if (crossesSection || (!intent.toggle && !intent.range)) {
      this.replaceWith(target);
      return true;
    }

    if (!intent.range) {
      // Expected O(1): no clone and no iteration over the selected targets.
      if (this.#targetKeys.has(targetKey)) this.#targetKeys.delete(targetKey);
      else this.#targetKeys.add(targetKey);
      this.source = this.#targetKeys.size > 0 ? target.source : null;
      this.active = target;
      this.anchor = intent.preserveAnchor ? this.anchor ?? target : target;
      return true;
    }

    const anchorIndex = this.anchor?.source === target.source
      ? visibleTargets.findIndex((candidate) => sameTarget(candidate, this.anchor))
      : -1;
    const targetIndex = visibleTargets.findIndex((candidate) => sameTarget(candidate, target));
    if (anchorIndex < 0 || targetIndex < 0) {
      this.replaceWith(target);
      return true;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    if (!intent.toggle) this.#targetKeys.clear();
    for (let index = start; index <= end; index += 1) {
      this.#targetKeys.add(workingTargetKey(visibleTargets[index]));
    }
    this.source = target.source;
    this.active = target;
    return true;
  }

  prepareContextMenu(repositoryId: string, target: WorkingFileTarget) {
    this.ensureRepository(repositoryId);
    if (this.has(target)) {
      if (sameTarget(this.active, target)) return false;
      this.active = target;
      return true;
    }
    this.replaceWith(target);
    return true;
  }

  selectAll(
    repositoryId: string,
    source: PatchSource,
    visibleTargets: readonly WorkingFileTarget[],
    focusedTarget: WorkingFileTarget,
  ) {
    this.ensureRepository(repositoryId);
    const sourceTargets = visibleTargets.filter((target) => target.source === source);
    if (sourceTargets.length === 0) return false;

    const anchor = this.anchor?.source === source
      && sourceTargets.some((target) => sameTarget(target, this.anchor))
      ? this.anchor
      : focusedTarget;
    this.#targetKeys.clear();
    for (const target of sourceTargets) this.#targetKeys.add(workingTargetKey(target));
    this.source = source;
    this.active = focusedTarget;
    this.anchor = anchor;
    return true;
  }

  activate(repositoryId: string, target: WorkingFileTarget) {
    const repositoryChanged = this.ensureRepository(repositoryId);
    if (!repositoryChanged && sameTarget(this.active, target)) return false;
    this.active = target;
    return true;
  }

  registerVisibleTargets(
    repositoryId: string,
    source: PatchSource,
    visibleTargets: readonly WorkingFileTarget[],
  ) {
    const repositoryChanged = this.ensureRepository(repositoryId);
    if (!this.anchor || this.anchor.source !== source) return repositoryChanged;
    if (visibleTargets.some((target) => sameTarget(target, this.anchor))) {
      return repositoryChanged;
    }
    this.anchor = null;
    return true;
  }

  reconcile(
    repositoryId: string,
    availableTargets: readonly WorkingFileTarget[],
    previousOrder: readonly string[],
  ) {
    if (this.repositoryId !== repositoryId) {
      this.reset(repositoryId);
      return true;
    }

    const available = new Map(availableTargets.map((target) => [workingTargetKey(target), target]));
    let changed = false;
    for (const key of this.#targetKeys) {
      if (!available.has(key)) {
        this.#targetKeys.delete(key);
        changed = true;
      }
    }

    let active = this.active ? available.get(workingTargetKey(this.active)) ?? null : null;
    let anchor = this.anchor ? available.get(workingTargetKey(this.anchor)) ?? null : null;
    if (!active && this.#targetKeys.size > 0) {
      active = nearestSurvivingTarget(
        this.#targetKeys,
        available,
        this.active ? workingTargetKey(this.active) : null,
        previousOrder,
        availableTargets,
      );
    }
    if (this.#targetKeys.size === 0) {
      this.source = null;
      if (!active) anchor = null;
    }

    if (!sameTarget(active, this.active)) changed = true;
    if (!sameTarget(anchor, this.anchor)) changed = true;
    this.active = active;
    this.anchor = anchor;
    return changed;
  }

  clear(repositoryId: string) {
    if (
      this.repositoryId === repositoryId
      && this.#targetKeys.size === 0
      && this.source === null
      && this.active === null
      && this.anchor === null
    ) {
      return false;
    }
    this.reset(repositoryId);
    return true;
  }

  beginSourceRemap(
    repositoryId: string,
    targets: readonly WorkingFileTarget[],
    destination: PatchSource,
  ) {
    this.ensureRepository(repositoryId);
    if (targets.length === 0) return false;
    const source = targets[0].source;
    if (
      source === destination
      || targets.some((target) => target.source !== source || !this.has(target))
    ) {
      return false;
    }
    const paths = [...new Set(targets.map((target) => target.path))].sort(compareRepositoryPaths);
    this.pendingSourceRemap = {
      repositoryId,
      paths,
      from: source,
      to: destination,
      activePath: this.active?.source === source ? this.active.path : null,
      anchorPath: this.anchor?.source === source ? this.anchor.path : null,
    };
    return true;
  }

  completeSourceRemap(
    repositoryId: string,
    succeeded: boolean,
    availableTargets: readonly WorkingFileTarget[],
  ) {
    const pending = this.pendingSourceRemap;
    this.pendingSourceRemap = null;
    if (!pending || pending.repositoryId !== repositoryId || !succeeded) return false;

    const requested = new Set(pending.paths);
    const destinationTargets = availableTargets.filter((target) => (
      target.source === pending.to && requested.has(target.path)
    ));
    this.#targetKeys.clear();
    for (const target of destinationTargets) this.#targetKeys.add(workingTargetKey(target));
    this.source = destinationTargets.length > 0 ? pending.to : null;
    this.active = destinationTargets.find((target) => target.path === pending.activePath)
      ?? destinationTargets[0]
      ?? null;
    this.anchor = destinationTargets.find((target) => target.path === pending.anchorPath) ?? null;
    return true;
  }

  targetsView(
    repositoryId: string,
    availableByKey: ReadonlyMap<string, WorkingFileTarget>,
  ): ReadonlySet<WorkingFileTarget> {
    const model = this;
    return Object.freeze(new ReadonlySetView(
      () => model.repositoryId === repositoryId ? model.size : 0,
      (target) => model.repositoryId === repositoryId && model.has(target),
      function* values(): SetIterator<WorkingFileTarget> {
        if (model.repositoryId !== repositoryId) return undefined;
        for (const key of model.selectedKeys()) {
          const target = availableByKey.get(key);
          if (target) yield target;
        }
      },
    ));
  }

  selectedPathsView(repositoryId: string, source: PatchSource): ReadonlySet<string> {
    const model = this;
    return Object.freeze(new ReadonlySetView(
      () => model.repositoryId === repositoryId && model.source === source ? model.size : 0,
      (path) => model.repositoryId === repositoryId
        && model.source === source
        && model.has({ path, source }),
      function* values(): SetIterator<string> {
        if (model.repositoryId !== repositoryId || model.source !== source) return undefined;
        for (const key of model.selectedKeys()) yield pathFromTargetKey(key);
      },
    ));
  }

  #clearSelection() {
    this.#targetKeys.clear();
    this.source = null;
    this.active = null;
    this.anchor = null;
  }

  private ensureRepository(repositoryId: string) {
    if (this.repositoryId === repositoryId) return false;
    this.reset(repositoryId);
    return true;
  }

  private replaceWith(target: WorkingFileTarget) {
    this.#targetKeys.clear();
    this.#targetKeys.add(workingTargetKey(target));
    this.source = target.source;
    this.active = target;
    this.anchor = target;
  }

  private reset(repositoryId: string) {
    this.#clearSelection();
    this.pendingSourceRemap = null;
    this.repositoryId = repositoryId;
  }
}

function compareRepositoryPaths(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function nearestSurvivingTarget(
  selectedKeys: Iterable<string>,
  available: ReadonlyMap<string, WorkingFileTarget>,
  oldActiveKey: string | null,
  previousOrder: readonly string[],
  currentOrder: readonly WorkingFileTarget[],
) {
  const previousPositions = new Map(previousOrder.map((key, index) => [key, index]));
  const currentPositions = new Map(
    currentOrder.map((target, index) => [workingTargetKey(target), index]),
  );
  const oldActiveIndex = oldActiveKey === null ? undefined : previousPositions.get(oldActiveKey);
  let nearestKey: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestCurrentIndex = Number.POSITIVE_INFINITY;

  for (const key of selectedKeys) {
    const previousIndex = previousPositions.get(key);
    const distance = oldActiveIndex !== undefined && previousIndex !== undefined
      ? Math.abs(previousIndex - oldActiveIndex)
      : Number.POSITIVE_INFINITY;
    const currentIndex = currentPositions.get(key) ?? Number.POSITIVE_INFINITY;
    if (
      distance < nearestDistance
      || (distance === nearestDistance && currentIndex < nearestCurrentIndex)
    ) {
      nearestKey = key;
      nearestDistance = distance;
      nearestCurrentIndex = currentIndex;
    }
  }
  return nearestKey ? available.get(nearestKey) ?? null : null;
}

class ReadonlySetView<T> implements ReadonlySet<T> {
  readonly [Symbol.toStringTag] = "Set";

  constructor(
    private readonly getSize: () => number,
    private readonly contains: (value: T) => boolean,
    private readonly iterate: () => SetIterator<T>,
  ) {}

  get size() {
    return this.getSize();
  }

  has(value: T) {
    return this.contains(value);
  }

  values() {
    return this.iterate();
  }

  keys() {
    return this.values();
  }

  *entries(): SetIterator<[T, T]> {
    for (const value of this.values()) yield [value, value];
  }

  forEach(
    callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ) {
    for (const value of this.values()) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator]() {
    return this.values();
  }
}

export function applyWorkingSelectionIntent(
  model: WorkingSelectionModel,
  repositoryId: string,
  target: WorkingFileTarget,
  visibleTargets: readonly WorkingFileTarget[],
  intent: FileSelectionIntent,
) {
  return model.select(repositoryId, target, visibleTargets, intent);
}

export function prepareWorkingContextSelection(
  model: WorkingSelectionModel,
  repositoryId: string,
  target: WorkingFileTarget,
) {
  return model.prepareContextMenu(repositoryId, target);
}

export function reconcileWorkingSelection(
  model: WorkingSelectionModel,
  repositoryId: string,
  availableTargets: readonly WorkingFileTarget[],
  previousOrder: readonly string[],
) {
  return model.reconcile(repositoryId, availableTargets, previousOrder);
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
  const availableTargetsRef = useRef(availableTargets);
  availableTargetsRef.current = availableTargets;
  const modelRef = useRef<WorkingSelectionModel | null>(null);
  if (!modelRef.current) modelRef.current = new WorkingSelectionModel(repositoryId);
  const model = modelRef.current;
  const [selectionRevision, bumpSelectionRevision] = useReducer((revision) => revision + 1, 0);

  useLayoutEffect(() => {
    const previous = previousOrder.current.slice();
    const next = availableTargets.map(workingTargetKey);
    previousOrder.current = next;
    if (reconcileWorkingSelection(model, repositoryId, availableTargets, previous)) {
      bumpSelectionRevision();
    }
  }, [availableTargets, model, repositoryId]);

  const notifyIfChanged = useCallback((changed: boolean) => {
    if (changed) bumpSelectionRevision();
  }, []);
  const select = useCallback((
    target: WorkingFileTarget,
    visibleTargets: readonly WorkingFileTarget[],
    intent: FileSelectionIntent,
  ) => {
    notifyIfChanged(applyWorkingSelectionIntent(
      model,
      repositoryId,
      target,
      visibleTargets,
      intent,
    ));
  }, [model, notifyIfChanged, repositoryId]);
  const selectAll = useCallback((
    source: PatchSource,
    visibleTargets: readonly WorkingFileTarget[],
    focusedTarget: WorkingFileTarget,
  ) => {
    notifyIfChanged(model.selectAll(repositoryId, source, visibleTargets, focusedTarget));
  }, [model, notifyIfChanged, repositoryId]);
  const activate = useCallback((target: WorkingFileTarget) => {
    notifyIfChanged(model.activate(repositoryId, target));
  }, [model, notifyIfChanged, repositoryId]);
  const prepareContextMenu = useCallback((target: WorkingFileTarget) => {
    notifyIfChanged(prepareWorkingContextSelection(model, repositoryId, target));
  }, [model, notifyIfChanged, repositoryId]);
  const registerVisibleTargets = useCallback((
    source: PatchSource,
    visibleTargets: readonly WorkingFileTarget[],
  ) => {
    notifyIfChanged(model.registerVisibleTargets(repositoryId, source, visibleTargets));
  }, [model, notifyIfChanged, repositoryId]);
  const clear = useCallback(() => {
    notifyIfChanged(model.clear(repositoryId));
  }, [model, notifyIfChanged, repositoryId]);
  const beginSourceRemap = useCallback((
    targets: readonly WorkingFileTarget[],
    destination: PatchSource,
  ) => model.beginSourceRemap(repositoryId, targets, destination), [model, repositoryId]);
  const completeSourceRemap = useCallback((succeeded: boolean) => {
    notifyIfChanged(model.completeSourceRemap(
      repositoryId,
      succeeded,
      availableTargetsRef.current,
    ));
  }, [model, notifyIfChanged, repositoryId]);
  const isSelected = useCallback(
    (target: WorkingFileTarget) => model.repositoryId === repositoryId && model.has(target),
    [model, repositoryId],
  );
  const selectedPaths = useCallback(
    (source: PatchSource) => model.selectedPathsView(repositoryId, source),
    [model, repositoryId, selectionRevision],
  );

  const stateMatchesRepository = model.repositoryId === repositoryId;
  const active = stateMatchesRepository && model.active
    ? availableByKey.get(workingTargetKey(model.active)) ?? null
    : null;
  const anchor = stateMatchesRepository && model.anchor
    ? availableByKey.get(workingTargetKey(model.anchor)) ?? null
    : null;
  const targets = useMemo(
    () => model.targetsView(repositoryId, availableByKey),
    [availableByKey, model, repositoryId, selectionRevision],
  );

  return {
    targets,
    source: stateMatchesRepository ? model.source : null,
    active,
    anchor,
    isSelected,
    selectedPaths,
    select,
    selectAll,
    activate,
    prepareContextMenu,
    registerVisibleTargets,
    clear,
    beginSourceRemap,
    completeSourceRemap,
  };
}
