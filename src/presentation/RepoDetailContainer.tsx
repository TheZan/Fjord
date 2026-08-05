import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/application/queryKeys";
import { useRepoStatus } from "@/application/useRepoStatus";
import type { CommitSummary } from "@/domain/git";
import type { RepositoryEntry } from "@/domain/workspace";
import {
  checkoutBranch,
  commitRepo,
  createBranch,
  fetchRepo,
  invokeErrorMessage,
  openInIde,
  openMergeTool,
  openTerminal,
  pullRepo,
  pushRepo,
  stageFiles,
  stashPop,
  stashPush,
  unstageFiles,
} from "@/infrastructure/tauriClient";
import { RepoDetailView } from "@/presentation/RepoDetailView";
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
  const { status, error: statusError } = useRepoStatus(repo.id);
  const [selectedCommit, setSelectedCommit] = useState<CommitSummary | null>(null);
  const [workingSelected, setWorkingSelected] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

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
      setActionError(invokeErrorMessage(e));
      return false;
    } finally {
      setActionPending(null);
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

    void runRepoAction("checkout", () => checkoutBranch(repo.id, command.branch));
    // The command id is the stable edge from the parent; the action runner is
    // intentionally recreated with current repo/query state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.id, repo.id]);

  function onAction(action: RepoAction) {
    const runners: Record<RepoAction, () => Promise<void>> = {
      fetch: () => fetchRepo(repo.id),
      pull: () => pullRepo(repo.id),
      push: () => pushRepo(repo.id),
      stash: () => stashPush(repo.id),
      "stash-pop": () => stashPop(repo.id),
      terminal: () => openTerminal(repo.id),
      "open-ide": () => openInIde(repo.id),
      "merge-tool": () => openMergeTool(repo.id),
    };
    const launchesExternalTool = action === "terminal" || action === "open-ide";
    void runRepoAction(action, runners[action], !launchesExternalTool);
  }

  function onCreateBranch(name: string) {
    void runRepoAction("create-branch", () => createBranch(repo.id, name, true));
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

  return (
    <RepoDetailView
      repo={repo}
      status={status}
      statusError={statusError}
      actionPending={actionPending}
      actionError={actionError}
      selectedCommit={selectedCommit}
      workingSelected={workingSelected}
      onBack={onBack}
      onAction={onAction}
      onCheckout={(branch) => void runRepoAction("checkout", () => checkoutBranch(repo.id, branch))}
      onCreateBranch={onCreateBranch}
      onOpenSearch={onOpenSearch}
      onSelectCommit={onSelectCommit}
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
