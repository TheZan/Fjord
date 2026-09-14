import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCommitDiff } from "@/application/useCommitDiff";
import {
  FileEntryList,
  FileTreeControls,
  FileViewTabs,
  useFileTreeCollapse,
  type FileViewMode,
} from "@/presentation/FileEntryList";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import { directoryPathsOf } from "@/presentation/fileTree";
import { formatDateTime } from "@/presentation/formatDateTime";
import type { CommitSummary } from "@/domain/git";

/**
 * The selected commit: metadata on top, its changed files below. The panel
 * fills its column and scrolls the file list internally — it used to grow
 * with the file count and take the whole page's scrollbar with it.
 */
export function CommitInspector({
  repoId,
  commit,
  selectedFilePath,
  onSelectFile,
}: {
  repoId: string;
  commit: CommitSummary;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const { t, i18n } = useTranslation("workspace");
  const { files, loading, statsLoading, statsReady, error } = useCommitDiff(repoId, commit.id);
  const [viewMode, setViewMode] = useState<FileViewMode>("path");
  const directoryPaths = useMemo(
    () => (viewMode === "tree" ? directoryPathsOf(files) : []),
    [files, viewMode],
  );
  const collapse = useFileTreeCollapse(directoryPaths);
  const selectedPaths = useMemo(
    () => new Set(selectedFilePath ? [selectedFilePath] : []),
    [selectedFilePath],
  );

  const authoredAt = formatDateTime(commit.authoredAt, i18n.language);

  return (
    <div
      className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      <div className="min-w-0 shrink-0 overflow-hidden border-b p-3" style={{ borderColor: "var(--hairline)" }}>
        <p
          className="selectable-text max-h-24 overflow-y-auto whitespace-pre-wrap font-medium [overflow-wrap:anywhere]"
          style={{ color: "var(--ink)" }}
        >
          {commit.message}
        </p>
        <div
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          style={{ color: "var(--mist)" }}
        >
          <span className="min-w-0 max-w-full truncate">
            {commit.authorName} &lt;{commit.authorEmail}&gt;
          </span>
          <span>{authoredAt}</span>
          <code className="selectable-text min-w-0 max-w-full truncate font-mono">{commit.id}</code>
        </div>
      </div>

      <div
        className="flex min-w-0 shrink-0 items-center justify-between gap-2 overflow-hidden border-b px-3 py-1.5"
        style={{ borderColor: "var(--hairline)" }}
      >
        <span className="truncate text-[11px]" style={{ color: "var(--mist)" }}>
          {t("working.fileCount", { count: files.length })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {viewMode === "tree" && <FileTreeControls collapse={collapse} />}
          <FileViewTabs mode={viewMode} onChange={setViewMode} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-2">
        {loading && (
          <p className="px-1 text-xs" style={{ color: "var(--mist)" }}>
            {t("commits.loading")}
          </p>
        )}
        {error && (
          <p className="px-1 text-xs" style={{ color: "var(--rust-ink)" }}>
            {error}
          </p>
        )}
        {!loading && !error && files.length === 0 && (
          <p className="px-1 text-xs" style={{ color: "var(--slate)" }}>
            {t("commitInspector.empty")}
          </p>
        )}
        {files.length > 0 && (
          <FileEntryList
            files={files}
            mode={viewMode}
            collapse={collapse}
            selectedPaths={selectedPaths}
            activePath={selectedFilePath}
            onSelect={(file) => onSelectFile(file.path)}
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
                {statsLoading ? "…" : statsReady ? (
                  <>
                    <span style={{ color: "var(--moss-ink)" }}>+{file.additions}</span>{" "}
                    <span style={{ color: "var(--rust-ink)" }}>−{file.deletions}</span>
                  </>
                ) : "—"}
              </span>
            )}
            fill
          />
        )}
      </div>
    </div>
  );
}
