import { useCallback, useState } from "react";
import type {
  IgnoreRuleKind,
  IgnoreRuleOutcome,
  IgnoreRulePreview,
  WorkingChanges,
  WorkingFileTarget,
} from "@/domain/git";
import { buildWholeFilePatchSelection } from "@/application/wholeFilePatchSelection";
import { pickSaveDestination } from "@/infrastructure/dialog";
import {
  exportPatch,
  getPatchText,
  openExternalDiff,
  openRepositoryPath,
  previewIgnoreRule,
  resolveRepositoryFilePath,
  revealRepositoryPath,
} from "@/infrastructure/tauriClient";

export type WorkingFileAction =
  | "stage"
  | "unstage"
  | "discard"
  | "delete"
  | "openEditor"
  | "openDefault"
  | "reveal"
  | "openMergeTool"
  | "openExternalDiff"
  | "stashFile"
  | "copyPaths"
  | "copyRelative"
  | "copyAbsolute"
  | "createPatch"
  | "copyPatch"
  | "ignoreFile"
  | "ignoreExtension"
  | "ignoreDirectory";

export interface WorkingFileActionContext {
  clickedTarget: WorkingFileTarget;
  /** Logical selection, never mounted rows or virtual items. */
  targets: readonly WorkingFileTarget[];
}

export interface IgnoreRuleState {
  target: WorkingFileTarget;
  kind: IgnoreRuleKind;
  preview: IgnoreRulePreview | null;
  loading: boolean;
  pending: boolean;
  outcome: IgnoreRuleOutcome | null;
  error: unknown | null;
}

export function useWorkingFileActions({
  repoId,
  repositoryName,
  changes,
  stashPathsSupported,
  onStage,
  onUnstage,
  onDiscard,
  onDelete,
  onOpenMergeTool,
  onStashFiles,
  onAddIgnore,
  onPatchSaved,
  onError,
}: {
  repoId: string;
  repositoryName: string;
  changes: WorkingChanges;
  stashPathsSupported: boolean;
  onStage: (paths: string[]) => boolean | void | Promise<boolean | void>;
  onUnstage: (paths: string[]) => boolean | void | Promise<boolean | void>;
  onDiscard: (targets: readonly WorkingFileTarget[]) => void;
  onDelete: (target: WorkingFileTarget) => void;
  onOpenMergeTool: () => void;
  onStashFiles: (paths: string[]) => void;
  onAddIgnore: (target: WorkingFileTarget, kind: IgnoreRuleKind) => Promise<IgnoreRuleOutcome | null>;
  onPatchSaved: (destination: string) => void;
  onError: (error: unknown) => void;
}) {
  const [ignoreRule, setIgnoreRule] = useState<IgnoreRuleState | null>(null);

  const dispatch = useCallback(async (
    action: WorkingFileAction,
    contextOrTarget: WorkingFileActionContext | WorkingFileTarget,
  ): Promise<boolean | void> => {
    const context = "clickedTarget" in contextOrTarget
      ? contextOrTarget
      : { clickedTarget: contextOrTarget, targets: [contextOrTarget] };
    const targets = canonicalTargets(context.targets);
    const target = context.clickedTarget;
    if (isSelectionAction(action)) {
      if (targets.length === 0 || !sourceHomogeneous(targets)) return false;
      const files = targets.map((selected) => fileForTarget(changes, selected));
      if (files.some((file) => file === undefined) || files.some((file) => file?.conflicted)) {
        return false;
      }
      const source = targets[0].source;
      const paths = targets.map((selected) => selected.path);
      if (action === "stage") {
        if (source !== "worktree") return false;
        return await onStage(paths);
      }
      if (action === "unstage") {
        if (source !== "index") return false;
        return await onUnstage(paths);
      }
      if (action === "stashFile") {
        if (source !== "worktree" || !stashPathsSupported) return false;
        onStashFiles(paths);
        return true;
      }
      if (action === "discard") {
        if (source !== "worktree") return false;
        onDiscard(targets);
        return true;
      }
      if (action === "createPatch" || action === "copyPatch") {
        try {
          const selections = await Promise.all(targets.map((selected) =>
            buildWholeFilePatchSelection(repoId, selected.path, selected.source)));
          if (action === "createPatch") {
            const suggestedName = selections.length === 1
              ? `${baseFileName(selections[0].path)}.patch`
              : `${baseFileName(repositoryName)}-${selections.length}-files.patch`;
            const destination = await pickSaveDestination(suggestedName);
            if (destination === null) return;
            await exportPatch(repoId, selections, destination);
            onPatchSaved(destination);
            return true;
          }
          const text = await getPatchText(repoId, selections);
          await navigator.clipboard?.writeText(text);
          return true;
        } catch (error) {
          onError(error);
          return false;
        }
      }
      await navigator.clipboard?.writeText(paths.join("\n"));
      return true;
    }

    const kind = ignoreKind(action);
    if (kind) {
      setIgnoreRule({ target, kind, preview: null, loading: true, pending: false, outcome: null, error: null });
      try {
        const preview = await previewIgnoreRule(repoId, target.path, kind);
        setIgnoreRule((current) => current?.target === target && current.kind === kind
          ? { ...current, preview, loading: false }
          : current);
      } catch (error) {
        setIgnoreRule((current) => current?.target === target && current.kind === kind
          ? { ...current, loading: false, error }
          : current);
      }
      return;
    }

    try {
      if (action === "delete") return onDelete(target);
      if (action === "openMergeTool") return onOpenMergeTool();
      if (action === "openExternalDiff") {
        return await openExternalDiff(repoId, target.path, target.source);
      }
      if (action === "openEditor") {
        return await openRepositoryPath(repoId, target.path, {
          kind: "configuredEditor",
          line: null,
        });
      }
      if (action === "openDefault") {
        return await openRepositoryPath(repoId, target.path, { kind: "defaultApplication" });
      }
      if (action === "reveal") return await revealRepositoryPath(repoId, target.path);
      if (action === "copyRelative") return await navigator.clipboard?.writeText(target.path);
      const resolved = await resolveRepositoryFilePath(repoId, target.path);
      await navigator.clipboard?.writeText(resolved.absolute);
    } catch (error) {
      onError(error);
    }
  }, [changes, onDelete, onDiscard, onError, onOpenMergeTool, onPatchSaved, onStage, onStashFiles, onUnstage, repoId, repositoryName, stashPathsSupported]);

  const confirmIgnoreRule = useCallback(async () => {
    if (!ignoreRule?.preview || ignoreRule.loading || ignoreRule.pending || ignoreRule.preview.alreadyPresent) return;
    setIgnoreRule((current) => current ? { ...current, pending: true, error: null } : current);
    try {
      const outcome = await onAddIgnore(ignoreRule.target, ignoreRule.kind);
      setIgnoreRule((current) => outcome === null
        ? null
        : current ? { ...current, pending: false, outcome } : current);
    } catch (error) {
      setIgnoreRule((current) => current ? { ...current, pending: false, error } : current);
    }
  }, [ignoreRule, onAddIgnore]);

  const closeIgnoreRule = useCallback(() => {
    setIgnoreRule((current) => current?.pending ? current : null);
  }, []);

  return { dispatch, ignoreRule, confirmIgnoreRule, closeIgnoreRule };
}

function isSelectionAction(action: WorkingFileAction) {
  return action === "stage"
    || action === "unstage"
    || action === "discard"
    || action === "stashFile"
    || action === "createPatch"
    || action === "copyPatch"
    || action === "copyPaths";
}

function canonicalTargets(targets: readonly WorkingFileTarget[]) {
  const unique = new Map<string, WorkingFileTarget>();
  for (const target of targets) unique.set(`${target.source}\0${target.path}`, target);
  return [...unique.values()].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.source === right.source) return 0;
    return left.source < right.source ? -1 : 1;
  });
}

function sourceHomogeneous(targets: readonly WorkingFileTarget[]) {
  return targets.every((target) => target.source === targets[0]?.source);
}

function fileForTarget(changes: WorkingChanges, target: WorkingFileTarget) {
  const section = target.source === "index" ? changes.staged : changes.unstaged;
  return section.find((file) => file.path === target.path);
}

function baseFileName(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function ignoreKind(action: WorkingFileAction): IgnoreRuleKind | null {
  if (action === "ignoreFile") return "file";
  if (action === "ignoreExtension") return "extension";
  if (action === "ignoreDirectory") return "directory";
  return null;
}
