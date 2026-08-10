import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import {
  FileEntryList,
  FileTreeControls,
  FileViewTabs,
  useFileTreeCollapse,
  type FileTreeCollapse,
  type FileViewMode,
} from "@/presentation/FileEntryList";
import { directoryPathsOf } from "@/presentation/fileTree";
import { Button, Input, Surface, Textarea } from "@/presentation/ui";
import type { WorkingChanges, WorkingFile } from "@/domain/git";

export interface SelectedWorkingFile {
  path: string;
  staged: boolean;
}

/**
 * The commit panel: what's staged, what isn't, and the message that will turn
 * the staged half into a commit. Mirrors GitKraken's right-hand pane — the
 * previous UI could stage and commit through the backend but had no screen
 * that ever showed uncommitted work.
 */
export function WorkingChangesPanel({
  changes,
  loading,
  error,
  busy,
  validated,
  selectedFile,
  onSelectFile,
  onStage,
  onUnstage,
  onCommit,
}: {
  changes: WorkingChanges;
  loading: boolean;
  error: string | null;
  busy: boolean;
  validated: boolean;
  selectedFile: SelectedWorkingFile | null;
  onSelectFile: (file: SelectedWorkingFile) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: (message: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("workspace");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [viewMode, setViewMode] = useState<FileViewMode>("path");
  // Both sections fold together, so the one pair of controls in the header
  // means what it says. Each list collapses differently, hence the union.
  const directoryPaths = useMemo(
    () => [...directoryPathsOf(changes.unstaged), ...directoryPathsOf(changes.staged)],
    [changes],
  );
  const collapse = useFileTreeCollapse(directoryPaths);

  const total = changes.staged.length + changes.unstaged.length;
  const canCommit = validated && changes.staged.length > 0 && summary.trim().length > 0 && !busy;

  async function commit() {
    if (!canCommit) return;
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
    if (await onCommit(message)) {
      setSummary("");
      setDescription("");
    }
  }

  return (
    <Surface className="flex h-full min-h-0 w-full flex-col text-sm" style={{ background: "var(--paper)" }}>
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--hairline)" }}
      >
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{t("working.title")}</p>
          <p className="text-[11px]" style={{ color: "var(--mist)" }}>
            {t("working.fileCount", { count: total })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {viewMode === "tree" && <FileTreeControls collapse={collapse} />}
          <FileViewTabs mode={viewMode} onChange={setViewMode} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="p-3 text-xs" style={{ color: "var(--rust-ink)" }}>
            {error}
          </p>
        )}
        {!error && loading && total === 0 && (
          <p className="p-3 text-xs" style={{ color: "var(--mist)" }}>
            {t("commits.loading")}
          </p>
        )}
        {!error && !loading && total === 0 && (
          <p className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            {t("working.clean")}
          </p>
        )}

        <FileSection
          label={t("working.unstaged")}
          files={changes.unstaged}
          staged={false}
          viewMode={viewMode}
          collapse={collapse}
          actionLabel={t("working.stage")}
          bulkLabel={t("working.stageAll")}
          busy={busy || !validated}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onAct={onStage}
        />
        <FileSection
          label={t("working.staged")}
          files={changes.staged}
          staged
          viewMode={viewMode}
          collapse={collapse}
          actionLabel={t("working.unstage")}
          bulkLabel={t("working.unstageAll")}
          busy={busy || !validated}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onAct={onUnstage}
        />
      </div>

      <div className="border-t p-2" style={{ borderColor: "var(--hairline)" }}>
        <Input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void commit();
          }}
          placeholder={t("working.summaryPlaceholder")}
          className="w-full"
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void commit();
          }}
          placeholder={t("working.descriptionPlaceholder")}
          rows={3}
          className="mt-1.5 w-full"
        />
        <Button
          variant="primary"
          disabled={!canCommit}
          onClick={() => void commit()}
          className="mt-1.5 w-full"
        >
          {t("working.commit", { count: changes.staged.length })}
        </Button>
      </div>
    </Surface>
  );
}

function FileSection({
  label,
  files,
  staged,
  viewMode,
  collapse,
  actionLabel,
  bulkLabel,
  busy,
  selectedFile,
  onSelectFile,
  onAct,
}: {
  label: string;
  files: WorkingFile[];
  staged: boolean;
  viewMode: FileViewMode;
  collapse: FileTreeCollapse;
  actionLabel: string;
  bulkLabel: string;
  busy: boolean;
  selectedFile: SelectedWorkingFile | null;
  onSelectFile: (file: SelectedWorkingFile) => void;
  onAct: (paths: string[]) => void;
}) {
  const { t } = useTranslation("workspace");
  if (files.length === 0) return null;

  const selectedPath =
    selectedFile && selectedFile.staged === staged ? selectedFile.path : null;

  return (
    <div className="p-2">
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
          {label} ({files.length})
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(files.map((file) => file.path))}
          className="interactive-control rounded px-1.5 py-0.5 text-[11px] disabled:opacity-40"
          style={{ color: "var(--fjord-ink)" }}
        >
          {bulkLabel}
        </button>
      </div>

      <FileEntryList
        files={files}
        mode={viewMode}
        collapse={collapse}
        selectedPath={selectedPath}
        onSelect={(file) => onSelectFile({ path: file.path, staged })}
        renderMark={(file) => (
          <span
            style={{ color: CHANGE_TYPE_COLOR[file.changeType] }}
            title={t(`commitInspector.changeType.${file.changeType}`)}
          >
            {t(`commitInspector.changeTypeMark.${file.changeType}`)}
          </span>
        )}
        renderTrailing={(file) => (
          <span className="flex shrink-0 items-center gap-1.5">
            {file.conflicted && (
              <span className="text-[10px]" style={{ color: "var(--rust-ink)" }}>
                {t("working.conflicted")}
              </span>
            )}
            <span
              role="button"
              tabIndex={busy ? -1 : 0}
              aria-disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                if (!busy) onAct([file.path]);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!busy) onAct([file.path]);
                }
              }}
              className="interactive-control rounded px-1.5 py-0.5 text-[10px] opacity-0 group-hover:opacity-100"
              style={{ background: "var(--page-bg)", color: "var(--fjord-ink)" }}
            >
              {actionLabel}
            </span>
          </span>
        )}
      />
    </div>
  );
}
