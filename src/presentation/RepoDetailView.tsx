import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DiffSource } from "@/application/useFileDiff";
import { mergeSourceForBranch } from "@/application/mergeBranchAction";
import type {
  WorkingFileAction,
  WorkingFileActionContext,
} from "@/application/useWorkingFileActions";
import { useWorkingFileSelection } from "@/application/useWorkingFileSelection";
import { CommitGraph, type BranchGraphScrollRequest } from "@/presentation/CommitGraph";
import { CommitInspector } from "@/presentation/CommitInspector";
import { FileDiffView } from "@/presentation/FileDiffView";
import { PerformanceBoundary } from "@/presentation/performance";
import { ResizableRepoLayout } from "@/presentation/ResizableRepoLayout";
import { RepoToolbar, type RepoAction } from "@/presentation/RepoToolbar";
import { RepoTree } from "@/presentation/RepoTree";
import { RemoteSection } from "@/presentation/RemoteSection";
import type { BranchContextAction, TagContextAction } from "@/presentation/RepoTree";
import { ConfirmActionDialog, SelectActionDialog, TextActionDialog } from "@/presentation/GitContextMenu";
import type { CommitContextAction } from "@/presentation/CommitGraph";
import { WorkingChangesPanel } from "@/presentation/WorkingChangesPanel";
import { WorkingFileContextMenu, type WorkingFileMenuState } from "@/presentation/WorkingFileContextMenu";
import { OperationBanner } from "@/presentation/OperationBanner";
import { Button, Muted, NotificationToast, ScreenSurface } from "@/presentation/ui";
import type {
  CommitSummary,
  AmendInfo,
  DestructiveAction,
  DiffWhitespaceMode,
  GenerationSet,
  MergeSource,
  PatchSelection,
  RepoStatus,
  StashId,
  WorkingChanges,
} from "@/domain/git";
import type { OperationControl, RepoOperationState } from "@/domain/generated";
import type { RemotePushResult, RepositoryEntry } from "@/domain/workspace";

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
  actionsValidated,
  status,
  statusError,
  operationState,
  operationStateError,
  operationInProgress,
  operationControlPending,
  actionPending,
  actionError,
  actionSuccess,
  actionNoticeSuppressed,
  onPopRetainedStash,
  actionConfirmation,
  operationProgress,
  branchScrollRequest,
  commitSearchRequestId,
  selectedCommit,
  selectedStashId,
  workingSelected,
  changes,
  changesLoading,
  changesError,
  onBack,
  onOpenRecoveryCenter,
  onAction,
  onOperationControl,
  onConfirmAction,
  onCancelActionConfirmation,
  onCancelOperation,
  onCheckout,
  onSelectBranch,
  onCreateBranch,
  onCreateBranchAt,
  onRenameBranch,
  onMergeBranch,
  onSquashMergeBranch,
  onPreflightAction,
  onSetBranchUpstream,
  onUnsetBranchUpstream,
  onPublishBranch,
  onPushToRemotes,
  onCreateTag,
  onCherryPick,
  onRevertCommit,
  utilities,
  onSelectCommit,
  onSelectStash,
  onRevealCommit,
  onSelectWorking,
  onStage,
  onUnstage,
  onPrepareAmend,
  onApplyHunk,
  onDiscardPatch,
  onWorkingFileAction,
  onCommit,
  pendingDraftMessage,
  onPendingDraftMessageConsumed,
  openWorkingDiffWhitespace,
  onWorkingDiffWhitespaceModeChange,
  diffToolDisabledReason,
  stashFileDisabledReason,
}: {
  repo: RepositoryEntry;
  snapshotValidated: boolean;
  snapshotCapturedAt: string | null;
  actionsValidated: boolean;
  status: RepoStatus | null;
  statusError: string | null;
  operationState: RepoOperationState | null;
  operationStateError: string | null;
  operationInProgress: boolean;
  operationControlPending: OperationControl | null;
  actionPending: string | null;
  actionError: string | null;
  actionSuccess: string | null;
  actionNoticeSuppressed: boolean;
  onPopRetainedStash: () => void;
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
  selectedStashId: StashId | null;
  workingSelected: boolean;
  changes: WorkingChanges;
  changesLoading: boolean;
  changesError: string | null;
  onBack: () => void;
  onOpenRecoveryCenter: () => void;
  onAction: (action: RepoAction) => void;
  onOperationControl: (control: OperationControl) => void;
  onConfirmAction: () => void;
  onCancelActionConfirmation: () => void;
  onCancelOperation: () => void;
  onCheckout: (branch: string) => void;
  onSelectBranch: (branch: string) => void;
  onCreateBranch: (name: string) => void;
  onCreateBranchAt: (name: string, target: string) => void;
  onRenameBranch: (oldName: string, newName: string) => void;
  onMergeBranch: (source: MergeSource) => void;
  onSquashMergeBranch: (source: MergeSource) => void;
  onPreflightAction: (action: DestructiveAction) => void;
  onSetBranchUpstream: (branch: string, upstream: string) => void;
  onUnsetBranchUpstream: (branch: string) => void;
  onPublishBranch: (branch: string) => void;
  onPushToRemotes: (remotes: string[]) => Promise<RemotePushResult[] | null>;
  onCreateTag: (name: string, target: string) => void;
  onCherryPick: (commitId: string) => void;
  onRevertCommit: (commitId: string) => void;
  utilities: ReactNode;
  onSelectCommit: (commit: CommitSummary) => void;
  onSelectStash: (stashId: StashId) => void;
  onRevealCommit: (commit: CommitSummary) => void;
  onSelectWorking: () => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onPrepareAmend: () => Promise<AmendInfo | null>;
  onApplyHunk: (selection: PatchSelection, expectedGenerations: GenerationSet) => Promise<boolean>;
  onDiscardPatch: (
    action: DestructiveAction,
    selection: PatchSelection,
    expectedGenerations: GenerationSet,
    confirmationToken: string,
  ) => Promise<boolean>;
  onWorkingFileAction: (
    action: WorkingFileAction,
    context: WorkingFileActionContext,
  ) => Promise<boolean | void>;
  onCommit: (message: string, amend: boolean, push: boolean) => Promise<boolean>;
  pendingDraftMessage: string | null;
  onPendingDraftMessageConsumed: () => void;
  openWorkingDiffWhitespace: { path: string; staged: boolean; mode: DiffWhitespaceMode } | null;
  onWorkingDiffWhitespaceModeChange: (
    target: { path: string; source: DiffSource } | null,
    mode: DiffWhitespaceMode,
  ) => void;
  /** Set when no external diff tool currently resolves. */
  diffToolDisabledReason?: string;
  /** Set when the resolved Git cannot run a pathspec-scoped `stash push`. */
  stashFileDisabledReason?: string;
}) {
  const { t } = useTranslation("workspace");
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);
  const workingSelection = useWorkingFileSelection(repo.id, changes);
  const selectedWorkingEntries = [...workingSelection.targets]
    .map((target) => {
      const section = target.source === "index" ? changes.staged : changes.unstaged;
      const file = section.find((candidate) => candidate.path === target.path);
      return file ? { file, target } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const selectedWorkingFile = workingSelection.active
    ? {
        path: workingSelection.active.path,
        staged: workingSelection.active.source === "index",
      }
    : null;
  const [dialog, setDialog] = useState<ContextDialog | null>(null);
  const [workingFileMenu, setWorkingFileMenu] = useState<WorkingFileMenuState | null>(null);
  const [compactLayout, setCompactLayout] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<{ id: number; message: string; tone: "success" | "error"; retainedStash: boolean } | null>(null);
  const previousPendingAction = useRef<string | null>(null);

  const workingFileCount = changes.staged.length + changes.unstaged.length;

  useEffect(() => {
    setSelectedCommitFile(null);
  }, [selectedCommit?.id]);

  useEffect(() => {
    if (!workingSelected) workingSelection.clear();
  }, [workingSelected, workingSelection.clear]);

  useEffect(() => {
    if (!workingFileMenu) return;
    const section = workingFileMenu.target.source === "index" ? changes.staged : changes.unstaged;
    if (!section.some((file) => file.path === workingFileMenu.target.path)) {
      setWorkingFileMenu(null);
    }
  }, [changes, workingFileMenu]);

  useEffect(() => {
    if (!branchScrollRequest) return;
    setSelectedCommitFile(null);
    workingSelection.clear();
  }, [branchScrollRequest, workingSelection.clear]);

  useEffect(() => {
    const completedAction = previousPendingAction.current;
    if (completedAction && !actionPending) {
      if (actionNoticeSuppressed) {
        previousPendingAction.current = actionPending;
        return;
      }
      setNotice({
        id: Date.now(),
        message: actionError ?? actionSuccess ?? t("notifications.operationCompleted"),
        tone: actionError ? "error" : "success",
        retainedStash: actionSuccess?.includes("stash@{") ?? false,
      });
    }
    previousPendingAction.current = actionPending;
  }, [actionError, actionNoticeSuppressed, actionPending, actionSuccess, t]);

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
  const applyDiffFile = diffTarget?.source.kind === "working"
    ? diffTarget.source.staged
      ? () => onUnstage([diffTarget.path])
      : () => onStage([diffTarget.path])
    : undefined;

  const inspector = workingSelected ? (
    <WorkingChangesPanel
      changes={changes}
      loading={changesLoading}
      error={changesError}
      busy={actionPending !== null}
      validated={actionsValidated}
      selection={workingSelection}
      onStage={onStage}
      onUnstage={onUnstage}
      onSelectionAction={handleWorkingFileAction}
      stashFileDisabledReason={stashFileDisabledReason}
      onFileContextMenu={(file, target, position) => {
        setWorkingFileMenu({ file, target, position });
      }}
      onPrepareAmend={onPrepareAmend}
      onCommit={onCommit}
      pendingDraftMessage={pendingDraftMessage}
      onPendingDraftMessageConsumed={onPendingDraftMessageConsumed}
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
        dataValidated={actionsValidated}
        actionPending={actionPending}
        operationProgress={operationProgress}
        operationInProgress={operationInProgress}
        onBack={onBack}
        onOpenRecoveryCenter={onOpenRecoveryCenter}
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

      <OperationBanner
        state={operationState}
        validated={actionsValidated}
        pendingControl={operationControlPending}
        onControl={onOperationControl}
        onOpenMergeTool={() => onAction("merge-tool")}
      />

      {(statusError || operationStateError) && (
        <p className="text-[13px]" style={{ color: "var(--rust-ink)" }}>
          {statusError ?? operationStateError}
        </p>
      )}

      {status?.hasConflict &&
        (!operationState || operationState.operation.kind === "normal") && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]"
          style={{ background: "var(--rust-tint)", color: "var(--rust-ink)" }}
        >
          <span><span aria-hidden="true">⚠</span> {t("repoStatus.conflict")}</span>
          <Button
            size="sm"
            disabled={actionPending !== null || !actionsValidated}
            title={!actionsValidated
              ? t("snapshot.validationFailed")
              : actionPending !== null
                ? t("operations.running")
                : undefined}
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
              selectedStashId={selectedStashId}
              onSelectBranch={onSelectBranch}
              onSelectStash={onSelectStash}
              onStashContextMenu={onSelectStash}
              onCheckout={onCheckout}
              checkoutDisabledReason={
                operationInProgress ? t("operationBanner.blockedActions") : undefined
              }
              onPublishBranch={onPublishBranch}
              onBranchContextAction={handleBranchContextAction}
              onTagContextAction={handleTagContextAction}
            />
          </PerformanceBoundary>
          <RemoteSection repoId={repo.id} onPushToRemotes={onPushToRemotes} />
          </div>
        }
        center={
          <div className="h-full min-h-0 pl-2">
          {diffTarget && (
            <FileDiffView
              repoId={repo.id}
              path={diffTarget.path}
              source={diffTarget.source}
              actionDisabled={!actionsValidated || actionPending !== null}
              onApplyFile={applyDiffFile}
              onApplyHunk={diffTarget.source.kind === "working" ? onApplyHunk : undefined}
              onDiscardPatch={
                diffTarget.source.kind === "working" && !diffTarget.source.staged
                  ? onDiscardPatch
                  : undefined
              }
              onBack={() =>
                workingSelected ? workingSelection.clear() : setSelectedCommitFile(null)
              }
              onWhitespaceModeChange={onWorkingDiffWhitespaceModeChange}
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
                onCheckout={operationInProgress ? undefined : onCheckout}
                onMergeBranch={onMergeBranch}
                onSquashMergeBranch={onSquashMergeBranch}
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
      {dialog?.kind === "setUpstream" && (
        <SelectActionDialog
          title={t("context.setUpstream")}
          description={t("context.setUpstreamDescription", { branch: dialog.branch })}
          label={t("context.upstreamBranch")}
          options={dialog.options}
          confirmLabel={t("context.setUpstream")}
          onClose={() => setDialog(null)}
          onConfirm={(upstream) => {
            setDialog(null);
            onSetBranchUpstream(dialog.branch, upstream);
          }}
        />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmActionDialog
          title={t(`context.confirm.${dialog.action}.title`)}
          description={t(`context.confirm.${dialog.action}.description`, { target: dialog.target })}
          confirmLabel={t(`context.confirm.${dialog.action}.button`)}
          danger={dialog.action === "reset"}
          resetModes={dialog.action === "reset"}
          onClose={() => setDialog(null)}
          onConfirm={(mode) => {
            setDialog(null);
            if (dialog.action === "cherryPick") onCherryPick(dialog.target);
            if (dialog.action === "revert") onRevertCommit(dialog.target);
            if (dialog.action === "reset") {
              onPreflightAction({ kind: "reset", commitId: dialog.target, mode: mode ?? "mixed" });
            }
          }}
        />
      )}
      {actionConfirmation && (
        <ConfirmActionDialog
          title={t(`context.confirm.${confirmationKey(actionConfirmation)}.title`)}
          description={t(`context.confirm.${confirmationKey(actionConfirmation)}.description`, { target: actionConfirmation.kind === "origin" ? undefined : actionConfirmation.branch })}
          confirmLabel={actionConfirmation.kind === "publish"
            ? t("remotes.pushAndSetUpstream")
            : t(`context.confirm.${confirmationKey(actionConfirmation)}.button`)}
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
          actionLabel={notice.retainedStash ? t("checkoutOverwrite.pop") : undefined}
          onAction={notice.retainedStash ? () => {
            setNotice(null);
            onPopRetainedStash();
          } : undefined}
        />
      ) : null}
      {workingFileMenu ? (
        <WorkingFileContextMenu
          state={workingFileMenu}
          selection={selectedWorkingEntries}
          busy={!actionsValidated || actionPending !== null}
          patchExportDisabledReason={
            openWorkingDiffWhitespace
              && openWorkingDiffWhitespace.mode !== "show"
              && openWorkingDiffWhitespace.path === workingFileMenu.target.path
              && openWorkingDiffWhitespace.staged === (workingFileMenu.target.source === "index")
              ? t("workingFile.disabled.whitespaceMode")
              : undefined
          }
          deleteDisabledReason={
            workingFileMenu.target.source === "worktree"
              && changes.staged.some((file) => file.path === workingFileMenu.target.path)
              ? t("workingFile.disabled.deleteAlsoStaged")
              : undefined
          }
          diffToolDisabledReason={diffToolDisabledReason}
          stashFileDisabledReason={stashFileDisabledReason}
          onClose={() => setWorkingFileMenu(null)}
          onAction={handleWorkingFileAction}
        />
      ) : null}
    </ScreenSurface>
  );

  async function handleWorkingFileAction(
    action: WorkingFileAction,
    context: WorkingFileActionContext,
  ) {
    const destination = action === "stage"
      ? "index" as const
      : action === "unstage"
        ? "worktree" as const
        : null;
    const remapPrepared = destination !== null
      && workingSelection.beginSourceRemap(context.targets, destination);
    const result = await onWorkingFileAction(action, context);
    if (remapPrepared) workingSelection.completeSourceRemap(result === true);
  }

  function handleBranchContextAction(
    action: BranchContextAction,
    branch: import("@/domain/git").BranchInfo,
    upstreamChoices: string[],
  ) {
    switch (action) {
      case "checkout": onCheckout(branch.name); break;
      case "merge": onMergeBranch(mergeSourceForBranch(branch)); break;
      case "squashMerge": onSquashMergeBranch(mergeSourceForBranch(branch)); break;
      case "createBranch": setDialog({ kind: "createBranch", target: branch.targetCommitId }); break;
      case "rename": setDialog({ kind: "renameBranch", branch: branch.name }); break;
      case "setUpstream": setDialog({ kind: "setUpstream", branch: branch.name, options: upstreamChoices }); break;
      case "unsetUpstream": onUnsetBranchUpstream(branch.name); break;
      case "publish": onPublishBranch(branch.name); break;
      case "delete": onPreflightAction({ kind: "deleteBranch", name: branch.name }); break;
      case "deleteRemote": {
        const [remote, ...branchParts] = branch.name.split("/");
        onPreflightAction({ kind: "deleteRemoteBranch", remote, branch: branchParts.join("/") });
        break;
      }
      case "copy": void copyText(branch.name); break;
    }
  }

  function handleTagContextAction(action: TagContextAction, tag: import("@/domain/git").TagInfo) {
    if (action === "createBranch") setDialog({ kind: "createBranch", target: tag.targetCommitId });
    if (action === "delete") onPreflightAction({ kind: "deleteTag", name: tag.name });
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
  | { kind: "setUpstream"; branch: string; options: string[] }
  | { kind: "confirm"; action: "cherryPick" | "revert" | "reset"; target: string };

async function copyText(value: string) {
  await navigator.clipboard?.writeText(value);
}

function confirmationKey(action: ActionConfirmation) {
  if (action.kind === "remote-checkout") return "remoteCheckout";
  if (action.kind === "publish") return "publishBranch";
  return action.action === "stash-pop" ? "stashPop" : action.action;
}
