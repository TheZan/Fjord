import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import { useAutoFetch } from "@/application/useAutoFetch";
import { useCommitLog } from "@/application/useCommitLog";
import { invalidateRepoData, type RepoDataScope } from "@/application/invalidateRepoData";
import { useOperationProgress } from "@/application/useOperationProgress";
import { useRepoStatus } from "@/application/useRepoStatus";
import { useRepositorySnapshot } from "@/application/useRepositorySnapshot";
import { useWorkingChanges } from "@/application/useWorkingChanges";
import type { CommitSummary, GenerationSet, PatchSelection } from "@/domain/git";
import type { RepositoryEntry } from "@/domain/workspace";
import {
  cancelOperation,
  checkoutBranch,
  cherryPick,
  commitRepo,
  createBranch,
  createBranchAt,
  createTag,
  deleteBranch,
  deleteRemoteBranch,
  deleteTag,
  invokeErrorCode,
  openInIde,
  openMergeTool,
  openTerminal,
  runFetchRepo,
  runPullRepo,
  runPublishBranch,
  runPushRepo,
  renameBranch,
  resetToCommit,
  revertCommit,
  stageFiles,
  stagePatch,
  stashPop,
  stashPush,
  unstageFiles,
  unstagePatch,
  type OperationProgressEvent,
  type OperationTask,
} from "@/infrastructure/tauriClient";
import { RepoDetailView } from "@/presentation/RepoDetailView";
import { useInteractionCommit } from "@/presentation/performance";
import type { BranchGraphScrollRequest } from "@/presentation/CommitGraph";
import type { RepoAction } from "@/presentation/RepoToolbar";

export type RepoDetailCommandPayload =
  | { kind: "checkout"; branch: string }
  | { kind: "repoAction"; action: RepoAction }
  | { kind: "selectCommit"; commit: CommitSummary }
  | { kind: "openCommitSearch" }
  | { kind: "refresh" };

export type RepoDetailCommand = RepoDetailCommandPayload & { id: number };

export function RepoDetailContainer({
  repo,
  autoFetch,
  command,
  onBack,
  utilities,
}: {
  repo: RepositoryEntry;
  autoFetch: boolean;
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
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionOperationId, setActionOperationId] = useState<string | null>(null);
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmation | null>(null);
  const { error: autoFetchError } = useAutoFetch(repo.id, autoFetch);
  const activeOperation = actionOperationId ? (operations[actionOperationId] ?? null) : null;
  const workingFileCount = changes.staged.length + changes.unstaged.length;

  async function runRepoAction(
    action: string,
    run: () => Promise<void>,
    scopes: RepoDataScope[] = [],
    handleError?: (error: unknown) => boolean,
  ): Promise<boolean> {
    setActionError(null);
    setActionPending(action);
    try {
      if (
        action !== "terminal" &&
        action !== "open-ide" &&
        !snapshot.validated &&
        !(await snapshot.ensureValidated())
      ) {
        setActionError(t("snapshot.validationFailed"));
        return false;
      }
      await run();
      if (scopes.length > 0) {
        if (scopes.includes("history")) setSelectedCommit(null);
        await invalidateRepoData(queryClient, repo.id, repo.workspaceId, scopes);
      }
      return true;
    } catch (e) {
      const handled = handleError?.(e) ?? false;
      if (!handled && invokeErrorCode(e) !== "operation_cancelled") {
        setActionError(userErrorMessage(e));
      }
      return false;
    } finally {
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
  }, [repo.id]);

  useEffect(() => {
    if (changesLoading) return;

    if (workingFileCount > 0) {
      if (!selectedCommit && !workingSelected) setWorkingSelected(true);
      return;
    }

    if (commitsLoading) return;

    if (workingSelected) {
      setWorkingSelected(false);
      setSelectedCommit(currentBranchTip(commits, status?.branch ?? null));
      return;
    }

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
        action === "push" ? offerToPublishBranch : undefined,
      );
      return;
    }

    const runners: Record<Exclude<RepoAction, "fetch" | "pull" | "push">, () => Promise<void>> = {
      stash: () => stashPush(repo.id),
      "stash-pop": () => stashPop(repo.id),
      terminal: () => openTerminal(repo.id),
      "open-ide": () => openInIde(repo.id),
      "merge-tool": () => openMergeTool(repo.id),
    };
    const localAction = action as Exclude<RepoAction, "fetch" | "pull" | "push">;
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

  function offerToPublishBranch(error: unknown): boolean {
    if (invokeErrorCode(error) !== "no_upstream") return false;
    setActionConfirmation({ kind: "publish", branch: status?.branch ?? "" });
    return true;
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

  function onCreateBranch(name: string) {
    void runRepoAction("create-branch", () => createBranch(repo.id, name, true), ["status", "working", "history", "refs"]);
  }

  function onCreateBranchAt(name: string, target: string) {
    void runRepoAction("create-branch", () => createBranchAt(repo.id, name, target, true), ["status", "working", "history", "refs"]).then((ok) => {
      if (ok) requestBranchGraphScroll(name);
    });
  }

  function onRenameBranch(oldName: string, newName: string) {
    void runRepoAction("rename-branch", () => renameBranch(repo.id, oldName, newName), ["status", "refs"]).then((ok) => {
      if (ok) requestBranchGraphScroll(newName);
    });
  }

  function onDeleteBranch(name: string) {
    void runRepoAction("delete-branch", () => deleteBranch(repo.id, name), ["status", "refs"]);
  }

  function onDeleteRemoteBranch(name: string) {
    void runRepoAction("delete-remote-branch", () => deleteRemoteBranch(repo.id, name), ["status", "refs"]);
  }

  function onCreateTag(name: string, target: string) {
    void runRepoAction("create-tag", () => createTag(repo.id, name, target), ["refs"]);
  }

  function onDeleteTag(name: string) {
    void runRepoAction("delete-tag", () => deleteTag(repo.id, name), ["refs"]);
  }

  function onCherryPick(commitId: string) {
    void runRepoAction("cherry-pick", () => cherryPick(repo.id, commitId), ["status", "working", "history", "refs"]);
  }

  function onRevertCommit(commitId: string) {
    void runRepoAction("revert", () => revertCommit(repo.id, commitId), ["status", "working", "history", "refs"]);
  }

  function onResetToCommit(commitId: string, mode: "soft" | "mixed" | "hard") {
    void runRepoAction("reset", () => resetToCommit(repo.id, commitId, mode), ["status", "working", "history", "refs"]);
  }

  function requestBranchGraphScroll(branch: string) {
    setWorkingSelected(false);
    setBranchScrollRequest((current) => ({ branch, id: (current?.id ?? 0) + 1 }));
  }

  function checkoutAndScrollToBranch(branch: string) {
    if (isOriginBranch(branch)) {
      setActionConfirmation({ kind: "remote-checkout", branch });
      return;
    }
    performCheckoutAndScrollToBranch(branch);
  }

  function performCheckoutAndScrollToBranch(branch: string) {
    requestBranchGraphScroll(branch);
    void runRepoAction("checkout", () => checkoutBranch(repo.id, branch), ["status", "working", "history", "refs"]).then((ok) => {
      if (ok) requestBranchGraphScroll(branch);
    });
  }

  function onStage(paths: string[]) {
    void runWorkingAction("stage", () => stageFiles(repo.id, paths));
  }

  function onUnstage(paths: string[]) {
    void runWorkingAction("unstage", () => unstageFiles(repo.id, paths));
  }

  function onApplyHunk(selection: PatchSelection, expectedGenerations: GenerationSet): Promise<boolean> {
    const action = selection.source === "worktree" ? "stage-hunk" : "unstage-hunk";
    const mutate = selection.source === "worktree" ? stagePatch : unstagePatch;
    return runRepoAction(
      action,
      () => mutate(repo.id, selection, expectedGenerations).then(() => undefined),
      ["status", "working"],
      (error) => {
        if (invokeErrorCode(error) !== "patch_stale") return false;
        setActionError(t("diff.patchStale"));
        void invalidateRepoData(queryClient, repo.id, repo.workspaceId, ["status", "working"]);
        return true;
      },
    );
  }

  function onCommit(message: string): Promise<boolean> {
    return runWorkingAction("commit", () => commitRepo(repo.id, message).then(() => undefined), ["status", "working", "history", "refs"]);
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
    snapshot.ready ? <RepoDetailView
      repo={repo}
      snapshotValidated={snapshot.validated}
      snapshotCapturedAt={snapshot.capturedAt}
      status={status}
      statusError={statusError}
      actionPending={actionPending}
      actionError={
        actionError ??
        (autoFetchError ? t("sync.autoFetchError", { error: autoFetchError }) : null)
      }
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
      onDeleteBranch={onDeleteBranch}
      onDeleteRemoteBranch={onDeleteRemoteBranch}
      onCreateTag={onCreateTag}
      onDeleteTag={onDeleteTag}
      onCherryPick={onCherryPick}
      onRevertCommit={onRevertCommit}
      onResetToCommit={onResetToCommit}
      utilities={utilities}
      onSelectCommit={onSelectCommit}
      onRevealCommit={onRevealCommit}
      onSelectWorking={() => {
        setSelectedCommit(null);
        setWorkingSelected(true);
      }}
      onStage={onStage}
      onUnstage={onUnstage}
      onApplyHunk={onApplyHunk}
      onCommit={onCommit}
    /> : (
      <div className="flex min-h-0 flex-1 items-center justify-center" aria-busy="true">
        <span className="text-[13px]" style={{ color: "var(--mist)" }}>
          {t("snapshot.loading")}
        </span>
      </div>
    )
  );
}

type ConfirmableAction = "fetch" | "pull" | "push" | "stash-pop";
type NetworkRepoAction = "fetch" | "pull" | "push";
type ActionConfirmation =
  | { kind: "origin"; action: ConfirmableAction }
  | { kind: "remote-checkout"; branch: string }
  | { kind: "publish"; branch: string };

function needsConfirmation(action: RepoAction): action is ConfirmableAction {
  return action === "fetch" || action === "pull" || action === "push" || action === "stash-pop";
}

function isNetworkAction(action: RepoAction): action is NetworkRepoAction {
  return action === "fetch" || action === "pull" || action === "push";
}

function scopesForRepoAction(action: RepoAction): RepoDataScope[] {
  switch (action) {
    case "fetch":
      return ["status", "history", "refs"];
    case "pull":
      return ["status", "working", "history", "refs"];
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
