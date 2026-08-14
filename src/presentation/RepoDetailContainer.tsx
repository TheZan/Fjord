import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import { useCommitLog } from "@/application/useCommitLog";
import { invalidateRepoData, type RepoDataScope } from "@/application/invalidateRepoData";
import {
  isWorkingDiffSnapshotRejected,
  rejectWorkingDiffSnapshot,
} from "@/application/diffSnapshotAuthority";
import { useOperationProgress } from "@/application/useOperationProgress";
import { useRepoStatus } from "@/application/useRepoStatus";
import { useRepoOperationState } from "@/application/useRepoOperationState";
import { useRepositorySnapshot } from "@/application/useRepositorySnapshot";
import { useWorkingChanges } from "@/application/useWorkingChanges";
import type { AmendInfo, CommitSummary, DestructiveAction, GenerationSet, PatchSelection } from "@/domain/git";
import type { OperationControl, RepoOperationState } from "@/domain/generated";
import type { RemotePushResult, RepositoryEntry } from "@/domain/workspace";
import {
  cancelOperation,
  checkoutBranch,
  cherryPick,
  commitRepo,
  createBranch,
  createBranchAt,
  createTag,
  discardPatch,
  getAmendInfo,
  invokeErrorCode,
  invokeErrorPaths,
  openInIde,
  openMergeTool,
  openTerminal,
  runFetchRepo,
  runCommitAndPushRepo,
  runPullRepo,
  runPublishBranch,
  runPushBranchToRemotes,
  runPushRepo,
  runContinueOperation,
  runSkipOperation,
  runExecuteDestructiveAction,
  runStashAndCheckout,
  setBranchUpstream,
  renameBranch,
  revertCommit,
  stageFiles,
  stagePatch,
  stashPush,
  unstageFiles,
  unstagePatch,
  unsetBranchUpstream,
  type OperationProgressEvent,
  type OperationTask,
} from "@/infrastructure/tauriClient";
import { RepoDetailView } from "@/presentation/RepoDetailView";
import { RecoveryCenter } from "@/presentation/RecoveryCenter";
import { DestructivePreflightDialog } from "@/presentation/DestructivePreflightDialog";
import { CheckoutOverwriteDialog } from "@/presentation/CheckoutOverwriteDialog";
import { useInteractionCommit } from "@/presentation/performance";
import type { BranchGraphScrollRequest } from "@/presentation/CommitGraph";
import type { RepoAction } from "@/presentation/RepoToolbar";
import { isOperationInProgress } from "@/presentation/OperationBanner";
import { queryKeys } from "@/application/queryKeys";

export type RepoDetailCommandPayload =
  | { kind: "checkout"; branch: string }
  | { kind: "repoAction"; action: RepoAction }
  | { kind: "selectCommit"; commit: CommitSummary }
  | { kind: "openCommitSearch" }
  | { kind: "refresh" };

export type RepoDetailCommand = RepoDetailCommandPayload & { id: number };

export function RepoDetailContainer({
  repo,
  command,
  onBack,
  utilities,
}: {
  repo: RepositoryEntry;
  command: RepoDetailCommand | null;
  onBack: () => void;
  utilities: ReactNode;
}) {
  useInteractionCommit();
  const { t } = useTranslation("workspace");
  const queryClient = useQueryClient();
  const operations = useOperationProgress();
  const snapshot = useRepositorySnapshot(repo.id);
  const { status, error: statusError } = useRepoStatus(repo.id, snapshot.ready);
  const { state: operationState, error: operationStateError } = useRepoOperationState(
    repo.id,
    snapshot.ready,
  );
  const { commits, loading: commitsLoading } = useCommitLog(repo.id, snapshot.ready);
  const {
    changes,
    loading: changesLoading,
    error: changesError,
  } = useWorkingChanges(repo.id, snapshot.ready);
  const [selectedCommit, setSelectedCommit] = useState<CommitSummary | null>(null);
  const [workingSelected, setWorkingSelected] = useState(false);
  const [branchScrollRequest, setBranchScrollRequest] = useState<BranchGraphScrollRequest | null>(null);
  const [commitSearchRequestId, setCommitSearchRequestId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionNoticeSuppressed, setActionNoticeSuppressed] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [recoveryCenterOpen, setRecoveryCenterOpen] = useState(false);
  const actionInFlight = useRef(false);
  const [actionOperationId, setActionOperationId] = useState<string | null>(null);
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmation | null>(null);
  const [forcePushPreflight, setForcePushPreflight] = useState(false);
  const [destructiveAction, setDestructiveAction] = useState<DestructiveAction | null>(null);
  const [checkoutOverwrite, setCheckoutOverwrite] = useState<CheckoutOverwrite | null>(null);
  const activeOperation = actionOperationId ? (operations[actionOperationId] ?? null) : null;
  const workingFileCount = changes.staged.length + changes.unstaged.length;
  const operationInProgress = isOperationInProgress(operationState?.operation);
  const actionsValidated = snapshot.validated && operationState !== null;

  async function runRepoAction(
    action: string,
    run: () => Promise<void>,
    scopes: RepoDataScope[] = [],
    handleError?: (error: unknown) => boolean | Promise<boolean>,
    invalidateOnFailure = false,
  ): Promise<boolean> {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    setActionError(null);
    setActionSuccess(null);
    setActionNoticeSuppressed(false);
    setActionPending(action);
    try {
      if (action !== "terminal" && action !== "open-ide") {
        let validatedOperationState = operationState;
        if (!snapshot.validated) {
          if (!(await snapshot.ensureValidated())) {
            setActionError(t("snapshot.validationFailed"));
            return false;
          }
          validatedOperationState = queryClient.getQueryData<RepoOperationState>(
            queryKeys.repos.operationState(repo.id),
          ) ?? null;
        }
        if (!validatedOperationState) {
          setActionError(t("snapshot.validationFailed"));
          return false;
        }
      }
      await run();
      if (scopes.length > 0) {
        if (scopes.includes("history")) setSelectedCommit(null);
        await invalidateRepoData(queryClient, repo.id, repo.workspaceId, scopes);
      }
      return true;
    } catch (e) {
      if (invalidateOnFailure && scopes.length > 0) {
        try {
          await invalidateRepoData(queryClient, repo.id, repo.workspaceId, scopes);
        } catch {
          // The original operation error remains authoritative. Query errors
          // are rendered through their ordinary read hooks.
        }
      }
      const handled = await (handleError?.(e) ?? false);
      if (!handled && invokeErrorCode(e) !== "operation_cancelled") {
        setActionError(userErrorMessage(e));
      }
      return false;
    } finally {
      actionInFlight.current = false;
      setActionPending(null);
      setActionOperationId(null);
    }
  }

  function runWorkingAction(
    action: string,
    run: () => Promise<void>,
    scopes: RepoDataScope[] = ["status", "working"],
  ): Promise<boolean> {
    return runRepoAction(action, run, scopes);
  }

  useEffect(() => {
    if (!command) return;

    if (command.kind === "selectCommit") {
      setWorkingSelected(false);
      setSelectedCommit(command.commit);
      return;
    }

    if (command.kind === "repoAction") {
      onAction(command.action);
      return;
    }

    if (command.kind === "openCommitSearch") {
      setCommitSearchRequestId(command.id);
      return;
    }

    if (command.kind === "refresh") {
      void snapshot.revalidate();
      return;
    }

    checkoutAndScrollToBranch(command.branch);
    // The command id is the stable edge from the parent; the action runner is
    // intentionally recreated with current repo/query state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.id, repo.id]);

  useEffect(() => {
    setSelectedCommit(null);
    setWorkingSelected(false);
    setRecoveryCenterOpen(false);
  }, [repo.id]);

  useEffect(() => {
    if (changesLoading) return;

    if (workingFileCount > 0) {
      if (!selectedCommit && !workingSelected) setWorkingSelected(true);
      return;
    }

    if (commitsLoading) return;

    if (!selectedCommit) {
      setSelectedCommit(currentBranchTip(commits, status?.branch ?? null));
    }
  }, [
    changesLoading,
    commits,
    commitsLoading,
    selectedCommit,
    status?.branch,
    workingFileCount,
    workingSelected,
  ]);

  function onAction(action: RepoAction) {
    if (operationInProgress && (action === "pull" || action === "stash-pop")) {
      setActionError(t("operationBanner.blockedActions"));
      return;
    }
    if (action === "stash-pop") {
      setDestructiveAction({ kind: "stashPop", index: 0 });
      return;
    }
    if (needsConfirmation(action)) {
      setActionConfirmation({ kind: "origin", action });
      return;
    }
    executeAction(action);
  }

  function executeAction(action: RepoAction) {
    if (isNetworkAction(action)) {
      void runRepoAction(
        action,
        async () => {
          const networkTask = startNetworkAction(action);
          setActionOperationId(networkTask.operationId);
          await networkTask.promise;
        },
        scopesForRepoAction(action),
        // A branch with no upstream is not a failure to report — it is a
        // branch that has never been published. Offer to publish it instead
        // of pushing somewhere the user never configured.
        action === "push" ? offerPushRecovery : undefined,
        action === "pull",
      );
      return;
    }

    const runners: Record<Exclude<RepoAction, "fetch" | "pull" | "push" | "stash-pop">, () => Promise<void>> = {
      stash: () => stashPush(repo.id),
      terminal: () => openTerminal(repo.id),
      "open-ide": () => openInIde(repo.id),
      "merge-tool": () => openMergeTool(repo.id),
    };
    const localAction = action as Exclude<RepoAction, "fetch" | "pull" | "push" | "stash-pop">;
    void runRepoAction(localAction, runners[localAction], scopesForRepoAction(action));
  }

  function startNetworkAction(action: NetworkRepoAction): OperationTask<void> {
    switch (action) {
      case "fetch":
        return runFetchRepo(repo.id);
      case "pull":
        return runPullRepo(repo.id);
      case "push":
        return runPushRepo(repo.id);
    }
  }

  function offerPushRecovery(error: unknown): boolean {
    const code = invokeErrorCode(error);
    if (code === "no_upstream") {
      setActionConfirmation({ kind: "publish", branch: status?.branch ?? "" });
      return true;
    }
    if (code === "git_non_fast_forward") {
      setForcePushPreflight(true);
      return true;
    }
    return false;
  }

  function publishCurrentBranch() {
    void runRepoAction(
      "publish",
      async () => {
        const task = runPublishBranch(repo.id);
        setActionOperationId(task.operationId);
        await task.promise;
      },
      ["status", "refs"],
    );
  }

  async function pushCurrentBranchToRemotes(
    remotes: string[],
  ): Promise<RemotePushResult[] | null> {
    let results: RemotePushResult[] | null = null;
    const succeeded = await runRepoAction(
      "push-remotes",
      async () => {
        const task = runPushBranchToRemotes(repo.id, remotes);
        setActionOperationId(task.operationId);
        results = await task.promise;
      },
      ["status", "refs"],
    );
    return succeeded ? results : null;
  }

  function onCreateBranch(name: string) {
    if (operationInProgress) {
      setActionError(t("operationBanner.blockedActions"));
      return;
    }
    void runRepoAction("create-branch", () => createBranch(repo.id, name, true), ["status", "working", "history", "refs"]);
  }

  function onCreateBranchAt(name: string, target: string) {
    if (operationInProgress) {
      setActionError(t("operationBanner.blockedActions"));
      return;
    }
    void runRepoAction("create-branch", () => createBranchAt(repo.id, name, target, true), ["status", "working", "history", "refs"]).then((ok) => {
      if (ok) requestBranchGraphScroll(name);
    });
  }

  function onCreateRecoveryBranch(name: string, target: string) {
    if (operationInProgress) {
      setActionError(t("operationBanner.blockedActions"));
      return;
    }
    void runRepoAction(
      "recovery-create-branch",
      () => createBranchAt(repo.id, name, target, false),
      ["refs", "history", "reflog"],
    );
  }

  function onRenameBranch(oldName: string, newName: string) {
    void runRepoAction("rename-branch", () => renameBranch(repo.id, oldName, newName), ["status", "refs"]).then((ok) => {
      if (ok) requestBranchGraphScroll(newName);
    });
  }

  function onCreateTag(name: string, target: string) {
    void runRepoAction("create-tag", () => createTag(repo.id, name, target), ["refs"]);
  }

  function onCherryPick(commitId: string) {
    void runRepoAction(
      "cherry-pick",
      () => cherryPick(repo.id, commitId),
      ["status", "operation", "working", "history", "refs"],
      undefined,
      true,
    );
  }

  function onRevertCommit(commitId: string) {
    void runRepoAction(
      "revert",
      () => revertCommit(repo.id, commitId),
      ["status", "operation", "working", "history", "refs"],
      undefined,
      true,
    );
  }

  function requestBranchGraphScroll(branch: string) {
    setWorkingSelected(false);
    setBranchScrollRequest((current) => ({ branch, id: (current?.id ?? 0) + 1 }));
  }

  function checkoutAndScrollToBranch(branch: string) {
    if (operationInProgress) {
      setActionError(t("operationBanner.blockedActions"));
      return;
    }
    if (isOriginBranch(branch)) {
      setActionConfirmation({ kind: "remote-checkout", branch });
      return;
    }
    performCheckoutAndScrollToBranch(branch);
  }

  function performCheckoutAndScrollToBranch(branch: string) {
    if (operationInProgress) {
      setActionError(t("operationBanner.blockedActions"));
      return;
    }
    requestBranchGraphScroll(branch);
    void runRepoAction(
      "checkout",
      () => checkoutBranch(repo.id, branch),
      ["status", "working", "history", "refs"],
      (error) => {
        if (invokeErrorCode(error) !== "checkout_would_overwrite") return false;
        setActionNoticeSuppressed(true);
        setCheckoutOverwrite({ branch, paths: invokeErrorPaths(error) });
        return true;
      },
    ).then((ok) => {
      if (ok) requestBranchGraphScroll(branch);
    });
  }

  function onStage(paths: string[]) {
    void runWorkingAction("stage", () => stageFiles(repo.id, paths));
  }

  function onUnstage(paths: string[]) {
    void runWorkingAction("unstage", () => unstageFiles(repo.id, paths));
  }

  function onOperationControl(control: OperationControl) {
    if (control === "abort") {
      setDestructiveAction({ kind: "abortOperation" });
      return;
    }
    const start = (): OperationTask<RepoOperationState> => {
      switch (control) {
        case "continue":
          return runContinueOperation(repo.id);
        case "skip":
          return runSkipOperation(repo.id);
      }
    };
    void runRepoAction(
      `operation-${control}`,
      async () => {
        const task = start();
        setActionOperationId(task.operationId);
        const nextState = await task.promise;
        queryClient.setQueryData(queryKeys.repos.operationState(repo.id), nextState);
      },
      ["status", "operation", "working", "history", "refs"],
      undefined,
      true,
    );
  }

  function onSetBranchUpstream(branch: string, upstream: string) {
    void runRepoAction(
      "set-upstream",
      () => setBranchUpstream(repo.id, branch, upstream),
      ["status", "refs"],
    );
  }

  function onUnsetBranchUpstream(branch: string) {
    void runRepoAction(
      "unset-upstream",
      () => unsetBranchUpstream(repo.id, branch),
      ["status", "refs"],
    );
  }

  function onApplyHunk(selection: PatchSelection, expectedGenerations: GenerationSet): Promise<boolean> {
    if (isWorkingDiffSnapshotRejected(queryClient, repo.id, selection.path, selection.source)) {
      return Promise.resolve(false);
    }
    const action = selection.source === "worktree" ? "stage-hunk" : "unstage-hunk";
    const mutate = selection.source === "worktree" ? stagePatch : unstagePatch;
    return runRepoAction(
      action,
      () => mutate(repo.id, selection, expectedGenerations).then(() => undefined),
      ["status", "working"],
      (error) => handleRejectedPatchMutation(error, selection),
    );
  }

  function onDiscardPatch(
    action: DestructiveAction,
    selection: PatchSelection,
    expectedGenerations: GenerationSet,
    confirmationToken: string,
  ): Promise<boolean> {
    if (isWorkingDiffSnapshotRejected(queryClient, repo.id, selection.path, selection.source)) {
      return Promise.resolve(false);
    }
    return runRepoAction(
      "discard-patch",
      () => discardPatch(
        repo.id,
        action,
        selection,
        expectedGenerations,
        confirmationToken,
      ).then(() => undefined),
      ["status", "working"],
      (error) => handleRejectedPatchMutation(error, selection),
    );
  }

  async function handleRejectedPatchMutation(error: unknown, selection: PatchSelection): Promise<boolean> {
    const code = invokeErrorCode(error);
    if (code !== "patch_stale" && code !== "preflight_stale" && code !== "patch_apply_failed") return false;

    // A rejected patch invalidates the rendered snapshot. TanStack Query can
    // retain that data after a failed refetch, so only a later successful,
    // authoritative working-diff result may release this latch.
    rejectWorkingDiffSnapshot(queryClient, repo.id, selection.path, selection.source);
    setActionConfirmation(null);
    setActionError(t(code === "preflight_stale" ? "diff.preflightStale" : "diff.patchStale"));
    try {
      await invalidateRepoData(queryClient, repo.id, repo.workspaceId, ["status", "working"]);
    } catch {
      // Query errors remain visible through the normal query error UI. The
      // rejected snapshot deliberately stays latched until a successful diff
      // result arrives.
    }
    return true;
  }

  async function onPrepareAmend(): Promise<AmendInfo | null> {
    let info: AmendInfo | null = null;
    const ok = await runRepoAction("amend-info", async () => {
      info = await getAmendInfo(repo.id);
    });
    return ok ? info : null;
  }

  function onCommit(message: string, amend: boolean, push: boolean): Promise<boolean> {
    if (!push) {
      return runWorkingAction("commit", () => commitRepo(repo.id, message, amend).then(() => undefined), ["status", "working", "history", "refs"]);
    }

    return runRepoAction(
      "commit-push",
      async () => {
        const task = runCommitAndPushRepo(repo.id, message, amend);
        setActionOperationId(task.operationId);
        const outcome = await task.promise;
        if (!outcome.pushSucceeded) {
          setActionError(t("working.commitPushFailed", {
            error: userErrorMessage({ code: outcome.pushErrorCode ?? "git_remote_error" }),
          }));
        }
      },
      ["status", "working", "history", "refs"],
    );
  }

  function onSelectCommit(commit: CommitSummary) {
    setWorkingSelected(false);
    setSelectedCommit((current) => (commit.id === current?.id ? null : commit));
  }

  function onRevealCommit(commit: CommitSummary) {
    setWorkingSelected(false);
    setSelectedCommit(commit);
  }

  return (
    snapshot.ready ? <>
    {recoveryCenterOpen ? (
      <RecoveryCenter
        repo={repo}
        ready={actionsValidated}
        actionPending={actionPending}
        actionError={actionError}
        actionSuccess={actionSuccess}
        onBack={() => setRecoveryCenterOpen(false)}
        onCreateBranch={onCreateRecoveryBranch}
        onRestore={(commitId) => setDestructiveAction({ kind: "recoveryRestore", commitId })}
      />
    ) : (
    <RepoDetailView
      repo={repo}
      snapshotValidated={snapshot.validated}
      snapshotCapturedAt={snapshot.capturedAt}
      actionsValidated={actionsValidated}
      status={status}
      statusError={statusError}
      operationState={operationState}
      operationStateError={operationStateError}
      operationInProgress={operationInProgress}
      operationControlPending={pendingOperationControl(actionPending)}
      onOperationControl={onOperationControl}
      actionPending={actionPending}
      actionSuccess={actionSuccess}
      actionNoticeSuppressed={actionNoticeSuppressed}
      onPopRetainedStash={() => setDestructiveAction({ kind: "stashPop", index: 0 })}
      actionError={actionError}
      operationProgress={toToolbarProgress(activeOperation)}
      branchScrollRequest={branchScrollRequest}
      commitSearchRequestId={commitSearchRequestId}
      onCancelOperation={() => {
        if (actionOperationId) void cancelOperation(actionOperationId);
      }}
      selectedCommit={selectedCommit}
      workingSelected={workingSelected}
      changes={changes}
      changesLoading={changesLoading}
      changesError={changesError}
      onBack={onBack}
      onOpenRecoveryCenter={() => setRecoveryCenterOpen(true)}
      onAction={onAction}
      actionConfirmation={actionConfirmation}
      onConfirmAction={() => {
        if (!actionConfirmation) return;
        const confirmation = actionConfirmation;
        setActionConfirmation(null);
        if (confirmation.kind === "origin") executeAction(confirmation.action);
        else if (confirmation.kind === "publish") publishCurrentBranch();
        else performCheckoutAndScrollToBranch(confirmation.branch);
      }}
      onCancelActionConfirmation={() => setActionConfirmation(null)}
      onCheckout={checkoutAndScrollToBranch}
      onSelectBranch={requestBranchGraphScroll}
      onCreateBranch={onCreateBranch}
      onCreateBranchAt={onCreateBranchAt}
      onRenameBranch={onRenameBranch}
      onPreflightAction={setDestructiveAction}
      onSetBranchUpstream={onSetBranchUpstream}
      onUnsetBranchUpstream={onUnsetBranchUpstream}
      onPublishBranch={(branch) => setActionConfirmation({ kind: "publish", branch })}
      onPushToRemotes={pushCurrentBranchToRemotes}
      onCreateTag={onCreateTag}
      onCherryPick={onCherryPick}
      onRevertCommit={onRevertCommit}
      utilities={utilities}
      onSelectCommit={onSelectCommit}
      onRevealCommit={onRevealCommit}
      onSelectWorking={() => {
        setSelectedCommit(null);
        setWorkingSelected(true);
      }}
      onStage={onStage}
      onUnstage={onUnstage}
      onPrepareAmend={onPrepareAmend}
      onApplyHunk={onApplyHunk}
      onDiscardPatch={onDiscardPatch}
      onCommit={onCommit}
    />
    )}
    {forcePushPreflight ? (
      <DestructivePreflightDialog
        repoId={repo.id}
        action={FORCE_WITH_LEASE_ACTION}
        onClose={() => setForcePushPreflight(false)}
        onConfirm={async (generations, confirmationToken) => {
          const ok = await runRepoAction(
            "force-push",
            async () => {
              const task = runPushRepo(repo.id, true, generations, confirmationToken);
              setActionOperationId(task.operationId);
              await task.promise;
            },
            ["status", "refs"],
          );
          if (ok) setForcePushPreflight(false);
        }}
      />
    ) : null}
    {checkoutOverwrite ? (
      <CheckoutOverwriteDialog
        branch={checkoutOverwrite.branch}
        paths={checkoutOverwrite.paths}
        pending={actionPending === "stash-checkout"}
        onCancel={() => setCheckoutOverwrite(null)}
        onDiscard={() => {
          const { branch } = checkoutOverwrite;
          setCheckoutOverwrite(null);
          setDestructiveAction({ kind: "checkoutDiscard", branch });
        }}
        onStash={() => {
          const { branch } = checkoutOverwrite;
          void runRepoAction(
            "stash-checkout",
            async () => {
              const task = runStashAndCheckout(repo.id, branch);
              setActionOperationId(task.operationId);
              const stashRef = await task.promise;
              setActionSuccess(t("checkoutOverwrite.stashed", { stashRef }));
            },
            ["status", "working", "history", "refs", "stashes"],
          ).then((ok) => {
            if (ok) {
              setCheckoutOverwrite(null);
              requestBranchGraphScroll(branch);
            }
          });
        }}
      />
    ) : null}
    {destructiveAction ? (
      <DestructivePreflightDialog
        repoId={repo.id}
        action={destructiveAction}
        onClose={() => setDestructiveAction(null)}
        onConfirm={async (generations, confirmationToken) => {
          const action = destructiveAction;
          const ok = await runRepoAction(
            `destructive-${action.kind}`,
            async () => {
              const task = runExecuteDestructiveAction(
                repo.id,
                action,
                generations,
                confirmationToken,
              );
              setActionOperationId(task.operationId);
              const nextState = await task.promise;
              if (nextState) {
                queryClient.setQueryData(queryKeys.repos.operationState(repo.id), nextState);
              }
            },
            scopesForDestructiveAction(action),
            undefined,
            action.kind === "abortOperation" || action.kind === "stashPop",
          );
          if (ok) setDestructiveAction(null);
        }}
      />
    ) : null}
    </> : (
      <div className="flex min-h-0 flex-1 items-center justify-center" aria-busy="true">
        <span className="text-[13px]" style={{ color: "var(--mist)" }}>
          {t("snapshot.loading")}
        </span>
      </div>
    )
  );
}

type ConfirmableAction = "fetch" | "pull" | "push";
const FORCE_WITH_LEASE_ACTION: DestructiveAction = { kind: "forceWithLease" };
type NetworkRepoAction = "fetch" | "pull" | "push";
type CheckoutOverwrite = { branch: string; paths: string[] };
type ActionConfirmation =
  | { kind: "origin"; action: ConfirmableAction }
  | { kind: "remote-checkout"; branch: string }
  | { kind: "publish"; branch: string };

function needsConfirmation(action: RepoAction): action is ConfirmableAction {
  return action === "fetch" || action === "pull" || action === "push";
}

function isNetworkAction(action: RepoAction): action is NetworkRepoAction {
  return action === "fetch" || action === "pull" || action === "push";
}

function scopesForDestructiveAction(action: DestructiveAction): RepoDataScope[] {
  switch (action.kind) {
    case "deleteBranch":
    case "deleteRemoteBranch":
    case "deleteTag":
      return ["status", "history", "refs"];
    case "stashPop":
      return ["status", "working", "stashes"];
    case "reset":
    case "checkoutDiscard":
    case "recoveryRestore":
      return ["status", "working", "history", "refs", "reflog"];
    case "abortOperation":
      return ["status", "operation", "working", "history", "refs"];
    case "discard":
    case "forceWithLease":
      return [];
  }
}

function scopesForRepoAction(action: RepoAction): RepoDataScope[] {
  switch (action) {
    case "fetch":
      return ["status", "history", "refs"];
    case "pull":
      return ["status", "operation", "working", "history", "refs"];
    case "push":
      return ["status", "refs"];
    case "stash":
    case "stash-pop":
      return ["status", "working", "stashes"];
    case "terminal":
    case "open-ide":
    case "merge-tool":
      return [];
  }
}

function isOriginBranch(branch: string) {
  return branch === "origin" || branch.startsWith("origin/") || branch.startsWith("refs/remotes/origin/");
}

function currentBranchTip(commits: CommitSummary[], branch: string | null) {
  if (branch) {
    const branchCommit = commits.find((commit) => commit.refs.includes(branch));
    if (branchCommit) return branchCommit;
  }
  return commits[0] ?? null;
}

function toToolbarProgress(event: OperationProgressEvent | null) {
  if (!event) return null;
  return {
    completed: event.completed,
    total: event.total,
    error: event.error,
    status: event.status,
  };
}

function pendingOperationControl(action: string | null): OperationControl | null {
  if (action === "operation-continue") return "continue";
  if (action === "operation-skip") return "skip";
  if (action === "operation-abort") return "abort";
  return null;
}
