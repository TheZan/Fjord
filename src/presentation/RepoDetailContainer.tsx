import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCommitLog } from "@/application/useCommitLog";
import { queryKeys } from "@/application/queryKeys";
import { useOperationProgress } from "@/application/useOperationProgress";
import { useRepoStatus } from "@/application/useRepoStatus";
import { useWorkingChanges } from "@/application/useWorkingChanges";
import type { CommitSummary } from "@/domain/git";
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
  invokeErrorMessage,
  openInIde,
  openMergeTool,
  openTerminal,
  runFetchRepo,
  runPullRepo,
  runPushRepo,
  renameBranch,
  resetToCommit,
  revertCommit,
  stageFiles,
  stashPop,
  stashPush,
  unstageFiles,
  type OperationProgressEvent,
  type OperationTask,
} from "@/infrastructure/tauriClient";
import { RepoDetailView } from "@/presentation/RepoDetailView";
import type { BranchGraphScrollRequest } from "@/presentation/CommitGraph";
import type { RepoAction } from "@/presentation/RepoToolbar";

export type RepoDetailCommandPayload =
  | { kind: "checkout"; branch: string }
  | { kind: "repoAction"; action: RepoAction }
  | { kind: "selectCommit"; commit: CommitSummary };

export type RepoDetailCommand = RepoDetailCommandPayload & { id: number };

export function RepoDetailContainer({
  repo,
  command,
  onBack,
  onOpenSearch,
}: {
  repo: RepositoryEntry;
  command: RepoDetailCommand | null;
  onBack: () => void;
  onOpenSearch: () => void;
}) {
  const queryClient = useQueryClient();
  const operations = useOperationProgress();
  const { status, error: statusError } = useRepoStatus(repo.id);
  const { commits, loading: commitsLoading } = useCommitLog(repo.id);
  const {
    changes,
    loading: changesLoading,
    error: changesError,
  } = useWorkingChanges(repo.id);
  const [selectedCommit, setSelectedCommit] = useState<CommitSummary | null>(null);
  const [workingSelected, setWorkingSelected] = useState(false);
  const [branchScrollRequest, setBranchScrollRequest] = useState<BranchGraphScrollRequest | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionOperationId, setActionOperationId] = useState<string | null>(null);
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmation | null>(null);
  const activeOperation = actionOperationId ? (operations[actionOperationId] ?? null) : null;
  const workingFileCount = changes.staged.length + changes.unstaged.length;

  async function invalidateRepoData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.repos.detail(repo.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.status(repo.workspaceId) }),
    ]);
  }

  async function runRepoAction(
    action: string,
    run: () => Promise<void>,
    mutates = true,
  ): Promise<boolean> {
    setActionError(null);
    setActionPending(action);
    try {
      await run();
      if (mutates) {
        setSelectedCommit(null);
        await invalidateRepoData();
      }
      return true;
    } catch (e) {
      if (invokeErrorCode(e) !== "operation_cancelled") {
        setActionError(invokeErrorMessage(e));
      }
      return false;
    } finally {
      setActionPending(null);
      setActionOperationId(null);
    }
  }

  function runWorkingAction(action: string, run: () => Promise<void>): Promise<boolean> {
    return runRepoAction(action, run, false).then(async (ok) => {
      if (ok) await invalidateRepoData();
      return ok;
    });
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
    const networkTask = startNetworkAction(action);
    if (networkTask) {
      setActionOperationId(networkTask.operationId);
      void runRepoAction(action, () => networkTask.promise);
      return;
    }

    const runners: Record<Exclude<RepoAction, "fetch" | "pull" | "push">, () => Promise<void>> = {
      stash: () => stashPush(repo.id),
      "stash-pop": () => stashPop(repo.id),
      terminal: () => openTerminal(repo.id),
      "open-ide": () => openInIde(repo.id),
      "merge-tool": () => openMergeTool(repo.id),
    };
    const launchesExternalTool = action === "terminal" || action === "open-ide";
    const localAction = action as Exclude<RepoAction, "fetch" | "pull" | "push">;
    void runRepoAction(localAction, runners[localAction], !launchesExternalTool);
  }

  function startNetworkAction(action: RepoAction): OperationTask<void> | null {
    switch (action) {
      case "fetch":
        return runFetchRepo(repo.id);
      case "pull":
        return runPullRepo(repo.id);
      case "push":
        return runPushRepo(repo.id);
      default:
        return null;
    }
  }

  function onCreateBranch(name: string) {
    void runRepoAction("create-branch", () => createBranch(repo.id, name, true));
  }

  function onCreateBranchAt(name: string, target: string) {
    void runRepoAction("create-branch", () => createBranchAt(repo.id, name, target, true)).then((ok) => {
      if (ok) requestBranchGraphScroll(name);
    });
  }

  function onRenameBranch(oldName: string, newName: string) {
    void runRepoAction("rename-branch", () => renameBranch(repo.id, oldName, newName)).then((ok) => {
      if (ok) requestBranchGraphScroll(newName);
    });
  }

  function onDeleteBranch(name: string) {
    void runRepoAction("delete-branch", () => deleteBranch(repo.id, name));
  }

  function onDeleteRemoteBranch(name: string) {
    void runRepoAction("delete-remote-branch", () => deleteRemoteBranch(repo.id, name));
  }

  function onCreateTag(name: string, target: string) {
    void runRepoAction("create-tag", () => createTag(repo.id, name, target));
  }

  function onDeleteTag(name: string) {
    void runRepoAction("delete-tag", () => deleteTag(repo.id, name));
  }

  function onCherryPick(commitId: string) {
    void runRepoAction("cherry-pick", () => cherryPick(repo.id, commitId));
  }

  function onRevertCommit(commitId: string) {
    void runRepoAction("revert", () => revertCommit(repo.id, commitId));
  }

  function onResetToCommit(commitId: string, mode: "soft" | "mixed" | "hard") {
    void runRepoAction("reset", () => resetToCommit(repo.id, commitId, mode));
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
    void runRepoAction("checkout", () => checkoutBranch(repo.id, branch)).then((ok) => {
      if (ok) requestBranchGraphScroll(branch);
    });
  }

  function onStage(paths: string[]) {
    void runWorkingAction("stage", () => stageFiles(repo.id, paths));
  }

  function onUnstage(paths: string[]) {
    void runWorkingAction("unstage", () => unstageFiles(repo.id, paths));
  }

  function onCommit(message: string): Promise<boolean> {
    return runWorkingAction("commit", () => commitRepo(repo.id, message).then(() => undefined));
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
    <RepoDetailView
      repo={repo}
      status={status}
      statusError={statusError}
      actionPending={actionPending}
      actionError={actionError}
      operationProgress={toToolbarProgress(activeOperation)}
      branchScrollRequest={branchScrollRequest}
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
      onOpenSearch={onOpenSearch}
      onSelectCommit={onSelectCommit}
      onRevealCommit={onRevealCommit}
      onSelectWorking={() => {
        setSelectedCommit(null);
        setWorkingSelected(true);
      }}
      onStage={onStage}
      onUnstage={onUnstage}
      onCommit={onCommit}
    />
  );
}

type ConfirmableAction = "fetch" | "pull" | "push" | "stash-pop";
type ActionConfirmation =
  | { kind: "origin"; action: ConfirmableAction }
  | { kind: "remote-checkout"; branch: string };

function needsConfirmation(action: RepoAction): action is ConfirmableAction {
  return action === "fetch" || action === "pull" || action === "push" || action === "stash-pop";
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
