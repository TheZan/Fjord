import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ConflictEntry, ConflictResolution, ConflictSet, ConflictSides } from "@/domain/git";
import type { WorkingFileAction } from "@/application/useWorkingFileActions";
import { ContextMenu, type ContextMenuItem } from "@/presentation/GitContextMenu";
import {
  FileEntryList,
  type FileContextMenuAnchor,
  type FileTreeCollapse,
} from "@/presentation/FileEntryList";

/** A `MarkResolved` refused by the backend's marker scan, awaiting "Stage anyway". */
export interface ConflictMarkerWarning {
  path: string;
  line: number;
}

/** Row actions that are not resolutions and reuse the working-file dispatcher. */
const FILE_ACTIONS = new Set<WorkingFileAction>([
  "openMergeTool",
  "openEditor",
  "reveal",
  "copyRelative",
  "copyAbsolute",
]);

const RESOLUTION_PREFIX = "resolve:";

/** The ref a side is named by; never "ours"/"theirs" (conflict-resolution.md §3). */
function sideLabels(sides: ConflictSides, t: TFunction<"workspace">) {
  return {
    ours: sides.oursLabel || t("conflicts.unknownSide"),
    theirs: sides.theirsLabel || t("conflicts.unknownSide"),
  };
}

export function conflictKindLabel(
  entry: ConflictEntry,
  sides: ConflictSides,
  t: TFunction<"workspace">,
): string {
  return t(`conflicts.kind.${entry.kind}`, sideLabels(sides, t));
}

/**
 * The resolutions the entry's kind offers (§4) — an inapplicable one is
 * absent, not merely disabled — then the existing merge-tool handoff, the
 * ordinary file actions, and Stage/Discard disabled with the conflict named.
 */
export function conflictMenuItems(
  entry: ConflictEntry,
  sides: ConflictSides,
  busy: boolean,
  t: TFunction<"workspace">,
): ContextMenuItem[] {
  const { ours, theirs } = sideLabels(sides, t);
  const resolution = (id: ConflictResolution, label: string, danger = false): ContextMenuItem => ({
    id: `${RESOLUTION_PREFIX}${id}`,
    label,
    danger,
    disabled: busy,
  });
  const resolutions: ContextMenuItem[] = (() => {
    switch (entry.kind) {
      case "bothModified":
      case "bothAdded":
        return [
          resolution("takeOurs", t("conflicts.takeSide", { ref: ours })),
          resolution("takeTheirs", t("conflicts.takeSide", { ref: theirs })),
          resolution("markResolved", t("conflicts.markResolved")),
        ];
      case "addedByUs":
      case "deletedByThem":
        return [
          resolution("keepFile", t("conflicts.keepFile", { ref: ours })),
          resolution("deleteFile", t("conflicts.deleteFile"), true),
        ];
      case "addedByThem":
      case "deletedByUs":
        return [
          resolution("keepFile", t("conflicts.keepFile", { ref: theirs })),
          resolution("deleteFile", t("conflicts.deleteFile"), true),
        ];
      case "bothDeleted":
        return [resolution("deleteFile", t("conflicts.deleteFile"), true)];
    }
  })();
  const conflicted = t("workingFile.disabled.pathIsConflicted", { path: entry.path });
  const hasWorktreeFile = entry.kind !== "bothDeleted";
  return [
    ...resolutions,
    { id: "openMergeTool", label: t("workingFile.openMergeTool"), separatorBefore: true },
    ...(hasWorktreeFile
      ? [
          { id: "openEditor", label: t("workingFile.openInConfiguredEditor") },
          { id: "reveal", label: t("workingFile.showInFolder") },
        ]
      : []),
    {
      id: "copyPath",
      label: t("workingFile.copyPath.label"),
      icon: "copy",
      children: [
        { id: "copyRelative", label: t("workingFile.copyPath.relative") },
        { id: "copyAbsolute", label: t("workingFile.copyPath.absolute") },
      ],
    },
    {
      id: "stage",
      label: t("workingFile.stage"),
      separatorBefore: true,
      disabled: true,
      disabledReason: conflicted,
    },
    {
      id: "discard",
      label: t("workingFile.discard"),
      disabled: true,
      disabledReason: conflicted,
    },
  ];
}

const NO_COLLAPSE: FileTreeCollapse = {
  collapsed: new Set(),
  toggle: () => undefined,
  collapseAll: () => undefined,
  expandAll: () => undefined,
  hasDirectories: false,
  allCollapsed: false,
};

/**
 * Working Changes' Conflicts group (conflict-resolution.md §6). Driven by the
 * live index read, so it appears after a conflicted squash merge or
 * `stash apply` with no operation banner at all, and disappears with the
 * last conflict. Resolution is a row action: no dialog, no banner.
 */
export function ConflictsGroup({
  conflicts,
  busy,
  markerWarning,
  onResolve,
  onFileAction,
  onDismissMarkerWarning,
}: {
  conflicts: ConflictSet;
  busy: boolean;
  markerWarning: ConflictMarkerWarning | null;
  onResolve: (path: string, resolution: ConflictResolution, allowMarkers: boolean) => void;
  onFileAction: (action: WorkingFileAction, path: string) => void;
  onDismissMarkerWarning: () => void;
}) {
  const { t } = useTranslation("workspace");
  const { t: tCommon } = useTranslation("common");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ entry: ConflictEntry; position: FileContextMenuAnchor } | null>(null);
  const { ours, theirs } = sideLabels(conflicts.sides, t);
  const selectedPaths = useMemo(() => new Set(activePath ? [activePath] : []), [activePath]);

  useEffect(() => {
    if (menu && !conflicts.entries.some((entry) => entry.path === menu.entry.path)) setMenu(null);
  }, [conflicts, menu]);

  if (conflicts.total === 0) return null;
  const warning = markerWarning && conflicts.entries.some((entry) => entry.path === markerWarning.path)
    ? markerWarning
    : null;

  return (
    <section className="p-2" aria-label={t("conflicts.group")} data-testid="conflicts-group">
      <div className="mb-1 flex items-center px-1">
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--rust-ink)" }}>
          {t("conflicts.group")} ({conflicts.total})
        </span>
      </div>
      {conflicts.sides.inverted ? (
        <p className="mb-1 px-1 text-[11px]" style={{ color: "var(--slate)" }}>
          {t("conflicts.rebaseSidesExplanation", { ours, theirs })}
        </p>
      ) : null}
      {conflicts.truncated ? (
        <p className="mb-1 px-1 text-[11px]" style={{ color: "var(--slate)" }}>
          {t("conflicts.truncated", { shown: conflicts.entries.length, total: conflicts.total })}
        </p>
      ) : null}
      {warning ? (
        <div
          role="alert"
          className="mb-1 flex flex-wrap items-center gap-2 rounded px-2 py-1.5 text-xs"
          style={{ background: "var(--rust-tint)", color: "var(--rust-ink)" }}
        >
          <span className="min-w-0 flex-1">
            {tCommon("errors.conflict_markers_present", { path: warning.path, line: warning.line })}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve(warning.path, "markResolved", true)}
            className="interactive-control shrink-0 rounded px-1.5 py-0.5 text-[11px] disabled:opacity-40"
            style={{ color: "var(--rust-ink)" }}
          >
            {t("conflicts.stageAnyway")}
          </button>
          <button
            type="button"
            onClick={onDismissMarkerWarning}
            className="interactive-control shrink-0 rounded px-1.5 py-0.5 text-[11px]"
            style={{ color: "var(--rust-ink)" }}
          >
            {t("conflicts.dismiss")}
          </button>
        </div>
      ) : null}
      <FileEntryList
        files={conflicts.entries}
        mode="path"
        collapse={NO_COLLAPSE}
        selectedPaths={selectedPaths}
        activePath={activePath}
        ariaLabel={t("conflicts.group")}
        onSelect={(entry) => setActivePath(entry.path)}
        onActivate={(entry) => setActivePath(entry.path)}
        onFileContextMenu={(entry, position) => {
          setActivePath(entry.path);
          setMenu({ entry, position });
        }}
        renderMark={() => (
          <span style={{ color: "var(--rust-ink)" }} aria-hidden="true">!</span>
        )}
        renderTrailing={(entry) => (
          <span className="shrink-0 truncate text-[10px]" style={{ color: "var(--rust-ink)" }}>
            {conflictKindLabel(entry, conflicts.sides, t)}
          </span>
        )}
      />
      {menu ? (
        <ContextMenu
          position={menu.position}
          ariaLabel={menu.entry.path}
          items={conflictMenuItems(menu.entry, conflicts.sides, busy, t)}
          onClose={() => setMenu(null)}
          onSelect={(id) => {
            const path = menu.entry.path;
            setMenu(null);
            if (id.startsWith(RESOLUTION_PREFIX)) {
              onResolve(path, id.slice(RESOLUTION_PREFIX.length) as ConflictResolution, false);
            } else if (FILE_ACTIONS.has(id as WorkingFileAction)) {
              onFileAction(id as WorkingFileAction, path);
            }
          }}
        />
      ) : null}
    </section>
  );
}
