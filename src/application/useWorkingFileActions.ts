import { useCallback, useState } from "react";
import type { IgnoreRuleKind, IgnoreRuleOutcome, IgnoreRulePreview, WorkingFileTarget } from "@/domain/git";
import { buildWholeFilePatchSelection } from "@/application/wholeFilePatchSelection";
import { pickSaveDestination } from "@/infrastructure/dialog";
import {
  exportPatch,
  getPatchText,
  openRepositoryPath,
  previewIgnoreRule,
  resolveRepositoryFilePath,
  revealRepositoryPath,
} from "@/infrastructure/tauriClient";

export type WorkingFileAction =
  | "stage"
  | "unstage"
  | "discard"
  | "openEditor"
  | "openDefault"
  | "reveal"
  | "openMergeTool"
  | "copyRelative"
  | "copyAbsolute"
  | "createPatch"
  | "copyPatch"
  | "ignoreFile"
  | "ignoreExtension"
  | "ignoreDirectory";

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
  onStage,
  onUnstage,
  onDiscard,
  onOpenMergeTool,
  onAddIgnore,
  onPatchSaved,
  onError,
}: {
  repoId: string;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (target: WorkingFileTarget) => void;
  onOpenMergeTool: () => void;
  onAddIgnore: (target: WorkingFileTarget, kind: IgnoreRuleKind) => Promise<IgnoreRuleOutcome | null>;
  onPatchSaved: (destination: string) => void;
  onError: (error: unknown) => void;
}) {
  const [ignoreRule, setIgnoreRule] = useState<IgnoreRuleState | null>(null);

  const dispatch = useCallback(async (action: WorkingFileAction, target: WorkingFileTarget) => {
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
      if (action === "stage") return onStage([target.path]);
      if (action === "unstage") return onUnstage([target.path]);
      if (action === "discard") return onDiscard(target);
      if (action === "openMergeTool") return onOpenMergeTool();
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
      if (action === "createPatch") {
        const selection = await buildWholeFilePatchSelection(repoId, target.path, target.source);
        const destination = await pickSaveDestination(`${baseFileName(target.path)}.patch`);
        if (destination === null) return;
        await exportPatch(repoId, selection, destination);
        return onPatchSaved(destination);
      }
      if (action === "copyPatch") {
        const selection = await buildWholeFilePatchSelection(repoId, target.path, target.source);
        const text = await getPatchText(repoId, selection);
        return await navigator.clipboard?.writeText(text);
      }
      const resolved = await resolveRepositoryFilePath(repoId, target.path);
      await navigator.clipboard?.writeText(resolved.absolute);
    } catch (error) {
      onError(error);
    }
  }, [onDiscard, onError, onOpenMergeTool, onPatchSaved, onStage, onUnstage, repoId]);

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
