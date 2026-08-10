import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DiffSource } from "@/application/useFileDiff";
import { CommitGraph, type BranchGraphScrollRequest } from "@/presentation/CommitGraph";
import { CommitInspector } from "@/presentation/CommitInspector";
import { FileDiffView } from "@/presentation/FileDiffView";
import { PerformanceBoundary } from "@/presentation/performance";
import { ResizableRepoLayout } from "@/presentation/ResizableRepoLayout";
import { RepoToolbar, type RepoAction } from "@/presentation/RepoToolbar";
import { RepoTree } from "@/presentation/RepoTree";
import type { BranchContextAction, TagContextAction } from "@/presentation/RepoTree";
import { ConfirmActionDialog, TextActionDialog } from "@/presentation/GitContextMenu";
import type { CommitContextAction } from "@/presentation/CommitGraph";
import { WorkingChangesPanel, type SelectedWorkingFile } from "@/presentation/WorkingChangesPanel";
import { Button, Muted, NotificationToast, ScreenSurface } from "@/presentation/ui";
import type { CommitSummary, RepoStatus, WorkingChanges } from "@/domain/git";
import type { RepositoryEntry } from "@/domain/workspace";

type ActionConfirmation =
  | { kind: "origin"; action: "fetch" | "pull" | "push" | "stash-pop" }
  | { kind: "remote-checkout"; branch: string }
  | { kind: "publish"; branch: string };

/**
 * A selected repository used to render *below* the dashboard, so clicking a
 * card appended a screenful of content far under the fold. It's a
 * drill-down now: a collapsible branch/tag tree on the left, history in the
 * middle — replaced by a full-detail file diff when one is selected — and
 * either the selected commit or the commit panel on the right.
 */
export function RepoDetailView({
  repo,
  snapshotValidated,
  snapshotCapturedAt,
  status,
  statusError,
  actionPending,
  actionError,
  actionConfirmation,
  operationProgress,
  branchScrollRequest,
  commitSearchRequestId,
  selectedCommit,
  workingSelected,
  changes,
  changesLoading,
  changesError,
  onBack,
  onAction,
  onConfirmAction,
  onCancelActionConfirmation,
  onCancelOperation,
  onCheckout,
  onSelectBranch,
  onCreateBranch,
  onCreateBranchAt,
  onRenameBranch,
  onDeleteBranch,
  onDeleteRemoteBranch,
  onCreateTag,
  onDeleteTag,
  onCherryPick,
  onRevertCommit,
  onResetToCommit,
  utilities,
  onSelectCommit,
  onRevealCommit,
  onSelectWorking,
  onStage,
  onUnstage,
  onCommit,
}: {
  repo: RepositoryEntry;
  snapshotValidated: boolean;
  snapshotCapturedAt: string | null;
  status: RepoStatus | null;
  statusError: string | null;
  actionPending: string | null;
  actionError: string | null;
  actionConfirmation: ActionConfirmation | null;
  operationProgress: {
    completed: number;
    total: number;
    error: string | null;
    status: string;
  } | null;
  branchScrollRequest: BranchGraphScrollRequest | null;
  commitSearchRequestId: number | null;
  selectedCommit: CommitSummary | null;
  workingSelected: boolean;
  changes: WorkingChanges;
  changesLoading: boolean;
  changesError: string | null;
  onBack: () => void;
  onAction: (action: RepoAction) => void;
  onConfirmAction: () => void;
  onCancelActionConfirmation: () => void;
  onCancelOperation: () => void;
  onCheckout: (branch: string) => void;
  onSelectBranch: (branch: string) => void;
  onCreateBranch: (name: string) => void;
  onCreateBranchAt: (name: string, target: string) => void;
  onRenameBranch: (oldName: string, newName: string) => void;
  onDeleteBranch: (name: string) => void;
  onDeleteRemoteBranch: (name: string) => void;
  onCreateTag: (name: string, target: string) => void;
  onDeleteTag: (name: string) => void;
  onCherryPick: (commitId: string) => void;
  onRevertCommit: (commitId: string) => void;
  onResetToCommit: (commitId: string, mode: "soft" | "mixed" | "hard") => void;
  utilities: ReactNode;
  onSelectCommit: (commit: CommitSummary) => void;
  onRevealCommit: (commit: CommitSummary) => void;
  onSelectWorking: () => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: (message: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("workspace");
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);
  const [selectedWorkingFile, setSelectedWorkingFile] = useState<SelectedWorkingFile | null>(null);
  const [dialog, setDialog] = useState<ContextDialog | null>(null);
  const [compactLayout, setCompactLayout] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<{ id: number; message: string; tone: "success" | "error" } | null>(null);
  const previousPendingAction = useRef<string | null>(null);

  const workingFileCount = changes.staged.length + changes.unstaged.length;

  useEffect(() => {
    setSelectedCommitFile(null);
  }, [selectedCommit?.id]);

  useEffect(() => {
    if (!branchScrollRequest) return;
    setSelectedCommitFile(null);
    setSelectedWorkingFile(null);
  }, [branchScrollRequest]);

  // A file that just got staged moves to the other list; keeping the old
  // selection would show a diff that no longer exists on that side.
  useEffect(() => {
    if (!selectedWorkingFile) return;
    const list = selectedWorkingFile.staged ? changes.staged : changes.unstaged;
    if (!list.some((file) => file.path === selectedWorkingFile.path)) setSelectedWorkingFile(null);
  }, [changes, selectedWorkingFile]);

  useEffect(() => {
    const completedAction = previousPendingAction.current;
    if (completedAction && !actionPending) {
      setNotice({
        id: Date.now(),
        message: actionError ?? t("notifications.operationCompleted"),
        tone: actionError ? "error" : "success",
      });
    }
    previousPendingAction.current = actionPending;
  }, [actionError, actionPending, t]);

  const diffTarget: { path: string; source: DiffSource } | null = workingSelected
    ? selectedWorkingFile
      ? {
          path: selectedWorkingFile.path,
          source: { kind: "working", staged: selectedWorkingFile.staged },
        }
      : null
    : selectedCommit && selectedCommitFile
      ? { path: selectedCommitFile, source: { kind: "commit", commitId: selectedCommit.id } }
      : null;

  const inspector = workingSelected ? (
    <WorkingChangesPanel
      changes={changes}
      loading={changesLoading}
      error={changesError}
      busy={actionPending !== null}
      validated={snapshotValidated}
      selectedFile={selectedWorkingFile}
      onSelectFile={setSelectedWorkingFile}
      onStage={onStage}
      onUnstage={onUnstage}
      onCommit={onCommit}
    />
  ) : selectedCommit ? (
    <CommitInspector
      repoId={repo.id}
      commit={selectedCommit}
      selectedFilePath={selectedCommitFile}
      onSelectFile={setSelectedCommitFile}
    />
  ) : (
    <Muted className="text-[12px]">{t("inspector.empty")}</Muted>
  );

  return (
    <ScreenSurface screen="repository" className="flex min-h-0 flex-1 flex-col gap-4">
      <RepoToolbar
        repo={repo}
        status={status}
        dataValidated={snapshotValidated}
        actionPending={actionPending}
        operationProgress={operationProgress}
        onBack={onBack}
        onAction={onAction}
        onCancelOperation={onCancelOperation}
        onCreateBranch={onCreateBranch}
        utilities={utilities}
        onOpenInspector={
          compactLayout && (workingSelected || selectedCommit)
            ? () => setInspectorDrawerOpen(true)
            : undefined
        }
      />

      <RepositorySnapshotMarker
        validated={snapshotValidated}
        capturedAt={snapshotCapturedAt}
      />

      {statusError && (
        <p className="text-[13px]" style={{ color: "var(--rust-ink)" }}>
          {statusError}
        </p>
      )}

      {status?.hasConflict && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]"
          style={{ background: "var(--rust-tint)", color: "var(--rust-ink)" }}
        >
          <span><span aria-hidden="true">⚠</span> {t("repoStatus.conflict")}</span>
          <Button
            size="sm"
            disabled={actionPending !== null || !snapshotValidated}
            onClick={() => onAction("merge-tool")}
          >
            {actionPending === "merge-tool"
              ? t("repoStatus.openingMergeTool")
              : t("repoStatus.openMergeTool")}
          </Button>
        </div>
      )}

      <ResizableRepoLayout
        right={inspector}
        rightOpen={inspectorDrawerOpen}
        rightLabel={t("inspector.title")}
        closeLabel={t("inspector.close")}
        onCloseRight={() => setInspectorDrawerOpen(false)}
        onCompactChange={setCompactLayout}
        left={
          <div className="h-full min-h-0 overflow-y-auto pr-2">
          <PerformanceBoundary id="repo-tree">
            <RepoTree
              repoId={repo.id}
              focusedBranch={branchScrollRequest?.branch ?? null}
              onSelectBranch={onSelectBranch}
              onCheckout={onCheckout}
              onBranchContextAction={handleBranchContextAction}
              onTagContextAction={handleTagContextAction}
            />
          </PerformanceBoundary>
          </div>
        }
        center={
          <div className="h-full min-h-0 pl-2">
          {diffTarget && (
            <FileDiffView
              repoId={repo.id}
              path={diffTarget.path}
              source={diffTarget.source}
              onBack={() =>
                workingSelected ? setSelectedWorkingFile(null) : setSelectedCommitFile(null)
              }
            />
          )}
          {/* Kept mounted (just hidden) rather than unmounted while a diff is
              open — unmounting reset the virtualizer's scroll position, so
              closing the diff always snapped the graph back to the top. */}
          <div className={`h-full min-h-0 ${diffTarget ? "hidden" : ""}`}>
            <PerformanceBoundary id="commit-graph">
              <CommitGraph
                repoId={repo.id}
                currentBranch={status?.branch ?? null}
                scrollToBranch={branchScrollRequest}
                openSearchRequestId={commitSearchRequestId}
                selectedCommitId={selectedCommit?.id ?? null}
                onSelectCommit={handleSelectCommit}
                onRevealCommit={handleRevealCommit}
                onCheckout={onCheckout}
                onCommitContextAction={handleCommitContextAction}
                workingFileCount={workingFileCount}
                workingSelected={workingSelected}
                onSelectWorking={handleSelectWorking}
              />
            </PerformanceBoundary>
          </div>
          </div>
        }
      />
      {dialog?.kind === "createBranch" && (
        <TextActionDialog
          title={t("context.createBranchHere")}
          description={t("context.createBranchDescription", { commit: dialog.target.slice(0, 7) })}
          label={t("context.branchName")}
          confirmLabel={t("context.create")}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            onCreateBranchAt(name, dialog.target);
          }}
        />
      )}
      {dialog?.kind === "renameBranch" && (
        <TextActionDialog
          title={t("context.renameBranch")}
          description={t("context.renameBranchDescription", { branch: dialog.branch })}
          label={t("context.branchName")}
          initialValue={dialog.branch}
          confirmLabel={t("context.rename")}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            onRenameBranch(dialog.branch, name);
          }}
        />
      )}
      {dialog?.kind === "createTag" && (
        <TextActionDialog
          title={t("context.createTagHere")}
          description={t("context.createTagDescription", { commit: dialog.target.slice(0, 7) })}
          label={t("context.tagName")}
          confirmLabel={t("context.create")}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            onCreateTag(name, dialog.target);
          }}
        />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmActionDialog
          title={t(`context.confirm.${dialog.action}.title`)}
          description={t(`context.confirm.${dialog.action}.description`, { target: dialog.target })}
          confirmLabel={t(`context.confirm.${dialog.action}.button`)}
          danger={dialog.action === "deleteBranch" || dialog.action === "deleteRemoteBranch" || dialog.action === "deleteTag" || dialog.action === "reset"}
          resetModes={dialog.action === "reset"}
          onClose={() => setDialog(null)}
          onConfirm={(mode) => {
            setDialog(null);
            if (dialog.action === "deleteBranch") onDeleteBranch(dialog.target);
            if (dialog.action === "deleteRemoteBranch") onDeleteRemoteBranch(dialog.target);
            if (dialog.action === "deleteTag") onDeleteTag(dialog.target);
            if (dialog.action === "cherryPick") onCherryPick(dialog.target);
            if (dialog.action === "revert") onRevertCommit(dialog.target);
            if (dialog.action === "reset") onResetToCommit(dialog.target, mode ?? "mixed");
          }}
        />
      )}
      {actionConfirmation && (
        <ConfirmActionDialog
          title={t(`context.confirm.${confirmationKey(actionConfirmation)}.title`)}
          description={t(`context.confirm.${confirmationKey(actionConfirmation)}.description`, { target: actionConfirmation.kind === "origin" ? undefined : actionConfirmation.branch })}
          confirmLabel={t(`context.confirm.${confirmationKey(actionConfirmation)}.button`)}
          danger={actionConfirmation.kind === "origin" && actionConfirmation.action === "stash-pop"}
          onClose={onCancelActionConfirmation}
          onConfirm={onConfirmAction}
        />
      )}
      {notice ? (
        <NotificationToast
          key={notice.id}
          message={notice.message}
          tone={notice.tone}
          closeLabel={t("notifications.close")}
          onClose={() => setNotice(null)}
        />
      ) : null}
    </ScreenSurface>
  );

  function handleBranchContextAction(action: BranchContextAction, branch: import("@/domain/git").BranchInfo) {
    switch (action) {
      case "checkout": onCheckout(branch.name); break;
      case "createBranch": setDialog({ kind: "createBranch", target: branch.targetCommitId }); break;
      case "rename": setDialog({ kind: "renameBranch", branch: branch.name }); break;
      case "delete": setDialog({ kind: "confirm", action: "deleteBranch", target: branch.name }); break;
      case "deleteRemote": setDialog({ kind: "confirm", action: "deleteRemoteBranch", target: branch.name }); break;
      case "copy": void copyText(branch.name); break;
    }
  }

  function handleTagContextAction(action: TagContextAction, tag: import("@/domain/git").TagInfo) {
    if (action === "createBranch") setDialog({ kind: "createBranch", target: tag.targetCommitId });
    if (action === "delete") setDialog({ kind: "confirm", action: "deleteTag", target: tag.name });
    if (action === "copy") void copyText(tag.name);
  }

  function handleCommitContextAction(action: CommitContextAction, commit: CommitSummary) {
    if (action === "createBranch") setDialog({ kind: "createBranch", target: commit.id });
    if (action === "createTag") setDialog({ kind: "createTag", target: commit.id });
    if (action === "cherryPick") setDialog({ kind: "confirm", action: "cherryPick", target: commit.id });
    if (action === "revert") setDialog({ kind: "confirm", action: "revert", target: commit.id });
    if (action === "reset") setDialog({ kind: "confirm", action: "reset", target: commit.id });
    if (action === "copySha") void copyText(commit.id);
  }

  function handleSelectCommit(commit: CommitSummary) {
    onSelectCommit(commit);
    if (compactLayout) setInspectorDrawerOpen(true);
  }

  function handleRevealCommit(commit: CommitSummary) {
    onRevealCommit(commit);
    if (compactLayout) setInspectorDrawerOpen(true);
  }

  function handleSelectWorking() {
    onSelectWorking();
    if (compactLayout) setInspectorDrawerOpen(true);
  }
}

export function RepositorySnapshotMarker({
  validated,
  capturedAt,
}: {
  validated: boolean;
  capturedAt: string | null;
}) {
  const { t, i18n } = useTranslation("workspace");
  if (validated || !capturedAt) return null;
  const captured = new Date(capturedAt);
  const time = Number.isNaN(captured.getTime())
    ? capturedAt
    : new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(captured);

  return (
    <p
      role="status"
      className="-mt-2 rounded-md px-3 py-1.5 text-[12px]"
      style={{ background: "var(--fjord-tint)", color: "var(--fjord-ink)" }}
    >
      {t("snapshot.stale", { time })}
    </p>
  );
}

type ContextDialog =
  | { kind: "createBranch"; target: string }
  | { kind: "renameBranch"; branch: string }
  | { kind: "createTag"; target: string }
  | { kind: "confirm"; action: "deleteBranch" | "deleteRemoteBranch" | "deleteTag" | "cherryPick" | "revert" | "reset"; target: string };

async function copyText(value: string) {
  await navigator.clipboard?.writeText(value);
}

function confirmationKey(action: ActionConfirmation) {
  if (action.kind === "remote-checkout") return "remoteCheckout";
  if (action.kind === "publish") return "publishBranch";
  return action.action === "stash-pop" ? "stashPop" : action.action;
}
