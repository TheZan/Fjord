import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStashFiles } from "@/application/useStashFiles";
import type { FileDiff, StashEntry, StashFileGroup, StashId } from "@/domain/git";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import {
  FileEntryList,
  FileTreeControls,
  FileViewTabs,
  useFileTreeCollapse,
  type FileViewMode,
} from "@/presentation/FileEntryList";
import { directoryPathsOf } from "@/presentation/fileTree";
import { formatDateTime } from "@/presentation/formatDateTime";
import { Button } from "@/presentation/ui";

export interface StashFileSelection {
  stashId: StashId;
  group: StashFileGroup;
  path: string;
}

export function StashInspector({
  repoId,
  stash,
  selectedFile,
  onSelectFile,
  onRevealInGraph,
}: {
  repoId: string;
  stash: StashEntry;
  selectedFile: StashFileSelection | null;
  onSelectFile: (selection: StashFileSelection) => void;
  onRevealInGraph?: () => void;
}) {
  const { t, i18n } = useTranslation("workspace");
  const { files, loading, error } = useStashFiles(repoId, stash.id);
  const [viewMode, setViewMode] = useState<FileViewMode>("path");
  const allFiles = useMemo(
    () => [...files.staged, ...files.worktree, ...files.untracked],
    [files.staged, files.untracked, files.worktree],
  );
  const directoryPaths = useMemo(
    () => (viewMode === "tree" ? directoryPathsOf(allFiles) : []),
    [allFiles, viewMode],
  );
  const collapse = useFileTreeCollapse(directoryPaths);

  return (
    <div
      className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      <div className="min-w-0 shrink-0 overflow-hidden border-b p-3" style={{ borderColor: "var(--hairline)" }}>
        <p className="selectable-text max-h-24 overflow-y-auto whitespace-pre-wrap font-medium [overflow-wrap:anywhere]">
          {stash.title}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: "var(--mist)" }}>
          <code className="font-mono">{stash.refName}</code>
          <span>
            {stash.branch
              ? t("stash.inspector.createdFrom", { branch: stash.branch })
              : t("stash.inspector.createdDetached")}
          </span>
          <span>
            {t("stash.inspector.baseCommit")} <code className="selectable-text font-mono" title={stash.base}>{stash.base.slice(0, 7)}</code>
          </span>
          <span>{formatDateTime(stash.createdAt, i18n.language)}</span>
          <span>{t("stash.inspector.files", { count: stash.filesChanged })}</span>
        </div>
        <p className="mt-2 text-[11px]" style={{ color: "var(--slate)" }}>
          {t("stash.inspector.applyIsUnstaged")}
        </p>
      </div>

      <div
        className="flex min-w-0 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5"
        style={{ borderColor: "var(--hairline)" }}
      >
        {onRevealInGraph ? (
          <Button size="sm" onClick={onRevealInGraph}>
            {t("stash.action.revealInGraph")}
          </Button>
        ) : <span />}
        <span className="flex items-center gap-1">
          {viewMode === "tree" && <FileTreeControls collapse={collapse} />}
          <FileViewTabs mode={viewMode} onChange={setViewMode} />
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && allFiles.length === 0 ? (
          <p className="px-1 text-xs" style={{ color: "var(--mist)" }}>{t("commits.loading")}</p>
        ) : null}
        {error ? (
          <p className="px-1 text-xs" style={{ color: "var(--rust-ink)" }}>{error}</p>
        ) : null}
        {!loading && !error && allFiles.length === 0 ? (
          <p className="px-1 text-xs" style={{ color: "var(--slate)" }}>{t("stash.inspector.empty")}</p>
        ) : null}
        <StashFileSection
          label={t("stash.inspector.groupStaged")}
          stashId={stash.id}
          group="index"
          files={files.staged}
          viewMode={viewMode}
          collapse={collapse}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
        />
        <StashFileSection
          label={t("stash.inspector.groupWorktree")}
          stashId={stash.id}
          group="worktree"
          files={files.worktree}
          viewMode={viewMode}
          collapse={collapse}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
        />
        <StashFileSection
          label={t("stash.inspector.groupUntracked")}
          stashId={stash.id}
          group="untracked"
          files={files.untracked}
          viewMode={viewMode}
          collapse={collapse}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
        />
        {files.truncated ? (
          <p role="status" className="px-1 py-2 text-xs" style={{ color: "var(--rust-ink)" }}>
            {t("stash.inspector.truncated")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function StashFileSection({
  label,
  stashId,
  group,
  files,
  viewMode,
  collapse,
  selectedFile,
  onSelectFile,
}: {
  label: string;
  stashId: StashId;
  group: StashFileGroup;
  files: FileDiff[];
  viewMode: FileViewMode;
  collapse: ReturnType<typeof useFileTreeCollapse>;
  selectedFile: StashFileSelection | null;
  onSelectFile: (selection: StashFileSelection) => void;
}) {
  const { t } = useTranslation("workspace");
  if (files.length === 0) return null;
  const selectedPath = selectedFile?.stashId === stashId && selectedFile.group === group ? selectedFile.path : null;
  const selectedPaths = new Set(selectedPath ? [selectedPath] : []);
  return (
    <section className="mb-2" aria-label={label}>
      <h3 className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
        {label} ({files.length})
      </h3>
      <FileEntryList
        files={files}
        mode={viewMode}
        collapse={collapse}
        selectedPaths={selectedPaths}
        activePath={selectedPath}
        onSelect={(file) => onSelectFile({ stashId, group, path: file.path })}
        ariaLabel={label}
        renderMark={(file) => (
          <span
            style={{ color: CHANGE_TYPE_COLOR[file.changeType] }}
            title={t(`commitInspector.changeType.${file.changeType}`)}
          >
            {t(`commitInspector.changeTypeMark.${file.changeType}`)}
          </span>
        )}
        renderTrailing={(file) => (
          <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--mist)" }}>
            <span style={{ color: "var(--moss-ink)" }}>+{file.additions}</span>{" "}
            <span style={{ color: "var(--rust-ink)" }}>−{file.deletions}</span>
          </span>
        )}
      />
    </section>
  );
}
