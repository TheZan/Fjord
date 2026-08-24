import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadUiState, saveRepoModes } from "@/infrastructure/uiState";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import {
  FileEntryList,
  FileTreeControls,
  FileViewTabs,
  useFileTreeCollapse,
  type FileTreeCollapse,
  type FileContextMenuAnchor,
  type FileViewMode,
} from "@/presentation/FileEntryList";
import { directoryPathsOf } from "@/presentation/fileTree";
import { Button, Input, Surface, Textarea } from "@/presentation/ui";
import type { AmendInfo, WorkingChanges, WorkingFile, WorkingFileTarget } from "@/domain/git";
import type { WorkingFileSelectionController } from "@/application/useWorkingFileSelection";

/**
 * The commit panel: what's staged, what isn't, and the message that will turn
 * the staged half into a commit. The previous UI could stage and commit through
 * the backend but had no screen that ever showed uncommitted work.
 */
export function WorkingChangesPanel({
  changes,
  loading,
  error,
  busy,
  validated,
  selection,
  onStage,
  onUnstage,
  onFileContextMenu,
  onPrepareAmend,
  onCommit,
  pendingDraftMessage,
  onPendingDraftMessageConsumed,
}: {
  changes: WorkingChanges;
  loading: boolean;
  error: string | null;
  busy: boolean;
  validated: boolean;
  selection: WorkingFileSelectionController;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onFileContextMenu?: (
    file: WorkingFile,
    target: WorkingFileTarget,
    anchor: FileContextMenuAnchor,
  ) => void;
  onPrepareAmend: () => Promise<AmendInfo | null>;
  onCommit: (message: string, amend: boolean, push: boolean) => Promise<boolean>;
  /** A suggested message set from outside (e.g. a squash merge's SQUASH_MSG). */
  pendingDraftMessage?: string | null;
  onPendingDraftMessageConsumed?: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [amendLoading, setAmendLoading] = useState(false);
  const [amendInfo, setAmendInfo] = useState<AmendInfo | null>(null);
  const [savedDraft, setSavedDraft] = useState<{ summary: string; description: string } | null>(null);
  const [viewMode, setViewMode] = useState<FileViewMode>("path");
  // Both sections fold together, so the one pair of controls in the header
  // means what it says. Each list collapses differently, hence the union.
  const directoryPaths = useMemo(
    () => [...directoryPathsOf(changes.unstaged), ...directoryPathsOf(changes.staged)],
    [changes],
  );
  const collapse = useFileTreeCollapse(directoryPaths);

  useEffect(() => {
    void loadUiState()
      .then((state) => setViewMode(state.repo.fileViewMode))
      .catch(() => undefined);
  }, []);

  const total = changes.staged.length + changes.unstaged.length;
  const selectedSource = selection.targets.values().next().value?.source ?? selection.active?.source;
  const selectionTotal = selectedSource === "index"
    ? changes.staged.length
    : selectedSource === "worktree"
      ? changes.unstaged.length
      : total;
  const canCommit = validated
    && (amend || changes.staged.length > 0)
    && summary.trim().length > 0
    && !busy
    && !amendLoading;

  async function commit(push = false) {
    if (!canCommit) return;
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
    if (await onCommit(message, amend, push)) {
      setSummary("");
      setDescription("");
      setAmend(false);
      setAmendInfo(null);
      setSavedDraft(null);
    }
  }

  async function toggleAmend(enabled: boolean) {
    if (!enabled) {
      setAmend(false);
      setAmendInfo(null);
      if (savedDraft) {
        setSummary(savedDraft.summary);
        setDescription(savedDraft.description);
      }
      setSavedDraft(null);
      return;
    }

    setAmendLoading(true);
    const draft = { summary, description };
    try {
      const info = await onPrepareAmend();
      if (!info) return;
      const message = splitCommitMessage(info.message);
      setSavedDraft(draft);
      setSummary(message.summary);
      setDescription(message.description);
      setAmendInfo(info);
      setAmend(true);
    } finally {
      setAmendLoading(false);
    }
  }

  useEffect(() => {
    const onShortcutCommit = () => void commit();
    document.addEventListener("fjord:commit", onShortcutCommit);
    return () => document.removeEventListener("fjord:commit", onShortcutCommit);
  });

  useEffect(() => {
    if (pendingDraftMessage === null || pendingDraftMessage === undefined) return;
    const message = splitCommitMessage(pendingDraftMessage);
    setSummary(message.summary);
    setDescription(message.description);
    onPendingDraftMessageConsumed?.();
    // Runs exactly once per pending message: the effect's own consumption
    // callback clears the prop before this could re-fire.
  }, [pendingDraftMessage]);

  function changeViewMode(mode: FileViewMode) {
    setViewMode(mode);
    void saveRepoModes(null, mode).catch(() => undefined);
  }

  return (
    <Surface className="flex h-full min-h-0 w-full flex-col text-sm" style={{ background: "var(--paper)" }}>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {t("workingChanges.selectionAnnouncement", {
          count: selection.targets.size,
          total: selectionTotal,
        })}
      </p>
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
          <FileViewTabs mode={viewMode} onChange={changeViewMode} />
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
          selection={selection}
          onAct={onStage}
          onFileContextMenu={onFileContextMenu}
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
          selection={selection}
          onAct={onUnstage}
          onFileContextMenu={onFileContextMenu}
        />
      </div>

      <div className="border-t p-2" style={{ borderColor: "var(--hairline)" }}>
        <label className="mb-2 flex items-center gap-2 text-xs" style={{ color: "var(--slate)" }}>
          <input
            type="checkbox"
            checked={amend}
            disabled={busy || !validated || amendLoading}
            onChange={(event) => void toggleAmend(event.target.checked)}
          />
          <span>{amendLoading ? t("working.loadingAmend") : t("working.amend")}</span>
        </label>
        {amendInfo?.publishedUpstream ? (
          <p
            role="alert"
            className="mb-2 rounded px-2 py-1.5 text-xs"
            style={{ background: "var(--rust-tint)", color: "var(--rust-ink)" }}
          >
            {t("working.amendPublishedWarning", { upstream: amendInfo.publishedUpstream })}
          </p>
        ) : null}
        <Input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder={t("working.summaryPlaceholder")}
          className="w-full"
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("working.descriptionPlaceholder")}
          rows={3}
          className="mt-1.5 w-full"
        />
        <div className="mt-1.5 flex gap-1">
          <Button
            variant="primary"
            disabled={!canCommit}
            onClick={() => void commit()}
            className="min-w-0 flex-1"
          >
            {amend
              ? t("working.amendCommit")
              : t("working.commit", { count: changes.staged.length })}
          </Button>
          <Button
            disabled={!canCommit}
            onClick={() => void commit(true)}
            className="min-w-0 flex-1"
          >
            {amend ? t("working.amendAndPush") : t("working.commitAndPush")}
          </Button>
        </div>
      </div>
    </Surface>
  );
}

function splitCommitMessage(message: string) {
  const normalized = message.replace(/\r\n/g, "\n").trimEnd();
  const newline = normalized.indexOf("\n");
  if (newline < 0) return { summary: normalized, description: "" };
  return {
    summary: normalized.slice(0, newline),
    description: normalized.slice(newline + 1).replace(/^\n/, ""),
  };
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
  selection,
  onAct,
  onFileContextMenu,
}: {
  label: string;
  files: WorkingFile[];
  staged: boolean;
  viewMode: FileViewMode;
  collapse: FileTreeCollapse;
  actionLabel: string;
  bulkLabel: string;
  busy: boolean;
  selection: WorkingFileSelectionController;
  onAct: (paths: string[]) => void;
  onFileContextMenu?: (
    file: WorkingFile,
    target: WorkingFileTarget,
    anchor: FileContextMenuAnchor,
  ) => void;
}) {
  const { t } = useTranslation("workspace");
  if (files.length === 0) return null;

  const source = staged ? "index" as const : "worktree" as const;
  const selectedPaths = new Set(
    [...selection.targets]
      .filter((target) => target.source === source)
      .map((target) => target.path),
  );
  const activePath = selection.active?.source === source ? selection.active.path : null;
  const targetFor = (path: string): WorkingFileTarget => ({ path, source });

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
        selectedPaths={selectedPaths}
        activePath={activePath}
        multiselectable
        ariaLabel={label}
        onSelect={(file, intent, visibleFiles) => {
          selection.select(
            targetFor(file.path),
            intent.range
              ? visibleFiles.map((visibleFile) => targetFor(visibleFile.path))
              : [],
            intent,
          );
        }}
        onActivate={(file) => selection.activate(targetFor(file.path))}
        onSelectAll={(visibleFiles, focusedFile) => selection.selectAll(
          source,
          visibleFiles.map((visibleFile) => targetFor(visibleFile.path)),
          targetFor(focusedFile.path),
        )}
        onVisibleFilesChange={(visibleFiles) => selection.registerVisibleTargets(
          source,
          visibleFiles.map((visibleFile) => targetFor(visibleFile.path)),
        )}
        onFileContextMenu={onFileContextMenu
          ? (file, anchor) => {
              const target = targetFor(file.path);
              selection.prepareContextMenu(target);
              onFileContextMenu(file, target, anchor);
            }
          : undefined}
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
