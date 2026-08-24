import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { WorkingFile, WorkingFileTarget } from "@/domain/git";
import type { WorkingFileAction } from "@/application/useWorkingFileActions";
import { ContextMenu, type ContextMenuItem } from "@/presentation/GitContextMenu";

export interface WorkingFileMenuState {
  file: WorkingFile;
  target: WorkingFileTarget;
  position: { x: number; y: number };
}

export function WorkingFileContextMenu({
  state,
  busy,
  patchExportDisabledReason,
  deleteDisabledReason,
  diffToolDisabledReason,
  stashFileDisabledReason,
  onAction,
  onClose,
}: {
  state: WorkingFileMenuState;
  busy: boolean;
  /** Set when the row's diff is the one currently open with a
   * whitespace-ignoring mode active — the displayed diff would not match
   * the exported patch. */
  patchExportDisabledReason?: string;
  /** Set when the same path also appears in the staged list — deleting the
   * worktree file would orphan independently staged content. */
  deleteDisabledReason?: string;
  /** Set when no external diff tool currently resolves (Auto with no
   * `diff.tool` configured, or a stored name Git cannot resolve). */
  diffToolDisabledReason?: string;
  /** Set when the resolved Git is older than 2.13 and cannot run a
   * pathspec-scoped `stash push`. */
  stashFileDisabledReason?: string;
  onAction: (action: WorkingFileAction, target: WorkingFileTarget) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  return (
    <ContextMenu
      position={state.position}
      items={workingFileMenuItems(
        state.file,
        state.target,
        busy,
        t,
        patchExportDisabledReason,
        deleteDisabledReason,
        diffToolDisabledReason,
        stashFileDisabledReason,
      )}
      onClose={onClose}
      onSelect={(id) => {
        onClose();
        onAction(id as WorkingFileAction, state.target);
      }}
    />
  );
}

export function workingFileMenuItems(
  file: WorkingFile,
  target: WorkingFileTarget,
  busy: boolean,
  t: TFunction<"workspace">,
  patchExportDisabledReason?: string,
  deleteDisabledReason?: string,
  diffToolDisabledReason?: string,
  stashFileDisabledReason?: string,
): ContextMenuItem[] {
  const copyPath: ContextMenuItem = {
    id: "copyPath",
    label: t("workingFile.copyPath.label"),
    icon: "copy",
    children: [
      { id: "copyRelative", label: t("workingFile.copyPath.relative") },
      { id: "copyAbsolute", label: t("workingFile.copyPath.absolute") },
    ],
  };
  const deleted = file.changeType === "deleted";
  const openItems: ContextMenuItem[] = deleted ? [] : [
    {
      id: "openEditor",
      label: t("workingFile.openInConfiguredEditor"),
      separatorBefore: true,
    },
    { id: "openDefault", label: t("workingFile.openWithDefault") },
    { id: "reveal", label: t("workingFile.showInFolder") },
  ];

  if (file.conflicted) {
    return [
      ...openItems.map((item, index) => ({ ...item, separatorBefore: index === 0 ? false : item.separatorBefore })),
      { id: "openMergeTool", label: t("workingFile.openMergeTool"), separatorBefore: true },
      { ...copyPath, separatorBefore: true },
    ];
  }

  const primary: ContextMenuItem[] = target.source === "worktree"
    ? [
        { id: "stage", label: t("workingFile.stage"), disabled: busy },
        { id: "discard", label: t("workingFile.discard"), disabled: busy },
      ]
    : [{ id: "unstage", label: t("workingFile.unstage"), disabled: busy }];
  const ignore = target.source === "worktree" ? ignoreMenuItem(file, busy, t) : null;
  const stashItem: ContextMenuItem | null = target.source === "worktree"
    ? {
        id: "stashFile",
        label: t("workingFile.stashFile.label"),
        disabled: busy || Boolean(stashFileDisabledReason),
        disabledReason: stashFileDisabledReason,
      }
    : null;
  const externalDiff: ContextMenuItem = {
    id: "openExternalDiff",
    label: t("workingFile.openExternalDiff"),
    disabled: Boolean(diffToolDisabledReason),
    disabledReason: diffToolDisabledReason,
    // `openItems` carries the leading separator for this visual group; when
    // the row is deleted, `openItems` is empty, so this item must open the
    // group itself instead of silently joining the one above it.
    separatorBefore: deleted,
  };
  const createPatch: ContextMenuItem = {
    id: "createPatch",
    label: target.source === "worktree" ? t("workingFile.createPatch") : t("workingFile.createPatchStaged"),
    disabled: Boolean(patchExportDisabledReason),
    disabledReason: patchExportDisabledReason,
  };
  const copyPatch: ContextMenuItem = {
    id: "copyPatch",
    label: t("workingFile.copyPatch"),
    disabled: Boolean(patchExportDisabledReason),
    disabledReason: patchExportDisabledReason,
  };
  const deleteItem: ContextMenuItem | null = target.source === "worktree" && !deleted
    ? {
        id: "delete",
        label: t("workingFile.delete"),
        danger: true,
        separatorBefore: true,
        disabled: busy || Boolean(deleteDisabledReason),
        disabledReason: deleteDisabledReason,
      }
    : null;
  return [
    ...primary,
    ...(ignore ? [ignore] : []),
    ...(stashItem ? [stashItem] : []),
    ...openItems,
    externalDiff,
    { ...copyPath, separatorBefore: true },
    createPatch,
    ...(target.source === "worktree" ? [copyPatch] : []),
    ...(deleteItem ? [deleteItem] : []),
  ];
}

function ignoreMenuItem(
  file: WorkingFile,
  busy: boolean,
  t: TFunction<"workspace">,
): ContextMenuItem {
  if (file.tracked) {
    return {
      id: "ignore",
      label: t("workingFile.ignore.label"),
      disabled: true,
      disabledReason: t("workingFile.ignore.trackedFile"),
      separatorBefore: true,
    };
  }

  const normalized = file.path.replaceAll("\\", "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1) : null;
  const directory = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : null;
  const children: ContextMenuItem[] = [
    { id: "ignoreFile", label: t("workingFile.ignore.file") },
  ];
  if (extension) {
    children.push({
      id: "ignoreExtension",
      label: t("workingFile.ignore.extension", { extension }),
    });
  }
  if (directory) {
    children.push({
      id: "ignoreDirectory",
      label: t("workingFile.ignore.directory", { directory }),
    });
  }
  return {
    id: "ignore",
    label: t("workingFile.ignore.label"),
    disabled: busy,
    separatorBefore: true,
    children,
  };
}
