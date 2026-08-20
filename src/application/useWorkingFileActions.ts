import { useCallback } from "react";
import type { WorkingFileTarget } from "@/domain/git";
import {
  openRepositoryPath,
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
  | "copyAbsolute";

export function useWorkingFileActions({
  repoId,
  onStage,
  onUnstage,
  onDiscard,
  onOpenMergeTool,
  onError,
}: {
  repoId: string;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (target: WorkingFileTarget) => void;
  onOpenMergeTool: () => void;
  onError: (error: unknown) => void;
}) {
  return useCallback(async (action: WorkingFileAction, target: WorkingFileTarget) => {
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
      if (action === "copyRelative") {
        return await navigator.clipboard?.writeText(target.path);
      }
      const resolved = await resolveRepositoryFilePath(repoId, target.path);
      await navigator.clipboard?.writeText(resolved.absolute);
    } catch (error) {
      onError(error);
    }
  }, [onDiscard, onError, onOpenMergeTool, onStage, onUnstage, repoId]);
}
