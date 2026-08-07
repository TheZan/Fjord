// Thin wrapper over Tauri's `invoke` — the only place `@tauri-apps/api`
// is imported directly. Command names must match docs/specs/ipc-commands.md
// and the `#[tauri::command]` fn names in crates/fjord-app exactly
// (verb_noun, snake_case, no translation layer).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Settings } from "@/domain/settings";
import type { BulkRepoResult, RepoStatusSummary, RepositoryEntry, Workspace } from "@/domain/workspace";
import type {
  BranchInfo,
  CommitPage,
  CommitSummary,
  FileDiff,
  FileDiffDetail,
  GlobalSearchResult,
  RepoStatus,
  StashEntry,
  TagInfo,
  WorkingChanges,
} from "@/domain/git";

export const OPERATION_PROGRESS_EVENT = "fjord-operation-progress";
export const REPOSITORY_CHANGED_EVENT = "fjord-repository-changed";

export interface RepositoryChangedEvent {
  repoId: string;
  status: boolean;
  working: boolean;
  history: boolean;
  refs: boolean;
  stashes: boolean;
  statusSummary: RepoStatusSummary | null;
}

export type OperationKind = "fetch" | "pull" | "push" | "bulk-fetch" | "bulk-pull";
export type OperationStatus =
  | "started"
  | "progress"
  | "repo-started"
  | "repo-finished"
  | "succeeded"
  | "failed"
  | "cancelled";

export type OperationScope =
  | { type: "repo"; repoId: string }
  | { type: "workspace"; workspaceId: string };

export interface OperationProgressEvent {
  operationId: string;
  kind: OperationKind;
  scope: OperationScope;
  status: OperationStatus;
  repoId: string | null;
  completed: number;
  total: number;
  message: string | null;
  error: string | null;
}

export interface OperationTask<T> {
  operationId: string;
  promise: Promise<T>;
}

export function invokeErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return null;
}

function invokeAbortable<T>(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const request = invoke<T>(command, args);
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (value) => {
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        if (!signal.aborted) reject(error);
      },
    ).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function nextOperationId(kind: OperationKind): string {
  if (globalThis.crypto?.randomUUID) {
    return `${kind}:${globalThis.crypto.randomUUID()}`;
  }
  return `${kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function invokeOperation<T>(
  kind: OperationKind,
  command: string,
  args: Record<string, unknown>,
): OperationTask<T> {
  const operationId = nextOperationId(kind);
  return {
    operationId,
    promise: invoke(command, { ...args, operationId }),
  };
}

export function listenOperationProgress(
  handler: (event: OperationProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<OperationProgressEvent>(OPERATION_PROGRESS_EVENT, (event) => {
    handler(event.payload);
  });
}

export function cancelOperation(operationId: string): Promise<boolean> {
  return invoke("cancel_operation", { operationId });
}

export function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export function updateSettings(settings: Settings): Promise<Settings> {
  return invoke("update_settings", { settings });
}

export function listWorkspaces(): Promise<Workspace[]> {
  return invoke("list_workspaces");
}

export function createWorkspace(name: string): Promise<Workspace> {
  return invoke("create_workspace", { name });
}

export function renameWorkspace(id: string, name: string): Promise<Workspace> {
  return invoke("rename_workspace", { id, name });
}

export function reorderWorkspaces(ids: string[]): Promise<void> {
  return invoke("reorder_workspaces", { ids });
}

export function deleteWorkspace(id: string): Promise<void> {
  return invoke("delete_workspace", { id });
}

export function listRepositories(workspaceId: string): Promise<RepositoryEntry[]> {
  return invoke("list_repositories", { workspaceId });
}

export function getWorkspaceStatus(workspaceId: string): Promise<RepoStatusSummary[]> {
  return invoke("get_workspace_status", { workspaceId });
}

export function refreshRepoStatus(repoId: string): Promise<RepoStatusSummary> {
  return invoke("refresh_repo_status", { repoId });
}

export function addRepository(workspaceId: string, path: string): Promise<RepositoryEntry> {
  return invoke("add_repository", { workspaceId, path });
}

export function importRepositories(workspaceId: string, root: string): Promise<RepositoryEntry[]> {
  return invoke("import_repositories", { workspaceId, root });
}

export function removeRepository(id: string): Promise<void> {
  return invoke("remove_repository", { id });
}

export function getBranches(repoId: string, signal?: AbortSignal): Promise<BranchInfo[]> {
  return invokeAbortable("get_branches", { repoId }, signal);
}

export function listenRepositoryChanges(
  handler: (event: RepositoryChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<RepositoryChangedEvent>(REPOSITORY_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

export function getTags(repoId: string, signal?: AbortSignal): Promise<TagInfo[]> {
  return invokeAbortable("get_tags", { repoId }, signal);
}

export function getRepoStatus(repoId: string, signal?: AbortSignal): Promise<RepoStatus> {
  return invokeAbortable("get_repo_status", { repoId }, signal);
}

export function getCommitLog(
  repoId: string,
  cursor: string | null,
  limit: number,
  signal?: AbortSignal,
): Promise<CommitPage> {
  return invokeAbortable("get_commit_log", { repoId, cursor, limit }, signal);
}

export function searchCommitLog(
  repoId: string,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<CommitSummary[]> {
  return invokeAbortable("search_commit_log", { repoId, query, limit }, signal);
}

export function globalSearch(
  query: string,
  workspaceId: string | null = null,
  limit = 30,
): Promise<GlobalSearchResult[]> {
  return invoke("global_search", { query, workspaceId, limit });
}

export function getCommitDiff(repoId: string, commitId: string, signal?: AbortSignal): Promise<FileDiff[]> {
  return invokeAbortable("get_commit_diff", { repoId, commitId }, signal);
}

export function getCommitFiles(
  repoId: string,
  commitId: string,
  signal?: AbortSignal,
): Promise<FileDiff[]> {
  return invokeAbortable("get_commit_files", { repoId, commitId }, signal);
}

export function getFileDiff(
  repoId: string,
  commitId: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileDiffDetail> {
  return invokeAbortable("get_file_diff", { repoId, commitId, path }, signal);
}

export function checkoutBranch(repoId: string, branch: string): Promise<void> {
  return invoke("checkout_branch", { repoId, branch });
}

export function getWorkingChanges(repoId: string, signal?: AbortSignal): Promise<WorkingChanges> {
  return invokeAbortable("get_working_changes", { repoId }, signal);
}

export function getWorkingFileDiff(
  repoId: string,
  path: string,
  staged: boolean,
  signal?: AbortSignal,
): Promise<FileDiffDetail> {
  return invokeAbortable("get_working_file_diff", { repoId, path, staged }, signal);
}

export function createBranch(repoId: string, name: string, checkout = true): Promise<void> {
  return invoke("create_branch", { repoId, name, checkout });
}

export function createBranchAt(repoId: string, name: string, target: string, checkout = true): Promise<void> {
  return invoke("create_branch_at", { repoId, name, target, checkout });
}

export function renameBranch(repoId: string, oldName: string, newName: string): Promise<void> {
  return invoke("rename_branch", { repoId, oldName, newName });
}

export function deleteBranch(repoId: string, name: string): Promise<void> {
  return invoke("delete_branch", { repoId, name });
}

export function deleteRemoteBranch(repoId: string, name: string): Promise<void> {
  return invoke("delete_remote_branch", { repoId, name });
}

export function createTag(repoId: string, name: string, target: string): Promise<void> {
  return invoke("create_tag", { repoId, name, target });
}

export function deleteTag(repoId: string, name: string): Promise<void> {
  return invoke("delete_tag", { repoId, name });
}

export function cherryPick(repoId: string, commitId: string): Promise<void> {
  return invoke("cherry_pick", { repoId, commitId });
}

export function revertCommit(repoId: string, commitId: string): Promise<void> {
  return invoke("revert_commit", { repoId, commitId });
}

export function resetToCommit(repoId: string, commitId: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
  return invoke("reset_to_commit", { repoId, commitId, mode });
}

export function getStashes(repoId: string, signal?: AbortSignal): Promise<StashEntry[]> {
  return invokeAbortable("get_stashes", { repoId }, signal);
}

export function stashPush(repoId: string, message: string | null = null): Promise<void> {
  return invoke("stash_push", { repoId, message });
}

export function stashPop(repoId: string): Promise<void> {
  return invoke("stash_pop", { repoId });
}

export function openTerminal(repoId: string): Promise<void> {
  return invoke("open_terminal", { repoId });
}

export function stageFiles(repoId: string, paths: string[]): Promise<void> {
  return invoke("stage_files", { repoId, paths });
}

export function unstageFiles(repoId: string, paths: string[]): Promise<void> {
  return invoke("unstage_files", { repoId, paths });
}

export function commitRepo(repoId: string, message: string): Promise<string> {
  return invoke("commit_repo", { repoId, message });
}

export function fetchRepo(
  repoId: string,
  remote: string | null = null,
  operationId: string | null = null,
): Promise<void> {
  return invoke("fetch_repo", { repoId, remote, operationId });
}

export function runFetchRepo(repoId: string, remote: string | null = null): OperationTask<void> {
  return invokeOperation("fetch", "fetch_repo", { repoId, remote });
}

export function pullRepo(repoId: string, operationId: string | null = null): Promise<void> {
  return invoke("pull_repo", { repoId, operationId });
}

export function runPullRepo(repoId: string): OperationTask<void> {
  return invokeOperation("pull", "pull_repo", { repoId });
}

export function pushRepo(repoId: string, operationId: string | null = null): Promise<void> {
  return invoke("push_repo", { repoId, operationId });
}

export function runPushRepo(repoId: string): OperationTask<void> {
  return invokeOperation("push", "push_repo", { repoId });
}

export function openMergeTool(repoId: string): Promise<void> {
  return invoke("open_merge_tool", { repoId });
}

export function openInIde(repoId: string, ide: string | null = null): Promise<void> {
  return invoke("open_in_ide", { repoId, ide });
}

export function bulkFetch(
  workspaceId: string,
  operationId: string | null = null,
): Promise<BulkRepoResult[]> {
  return invoke("bulk_fetch", { workspaceId, operationId });
}

export function runBulkFetch(workspaceId: string): OperationTask<BulkRepoResult[]> {
  return invokeOperation("bulk-fetch", "bulk_fetch", { workspaceId });
}

export function bulkPull(
  workspaceId: string,
  operationId: string | null = null,
): Promise<BulkRepoResult[]> {
  return invoke("bulk_pull", { workspaceId, operationId });
}

export function runBulkPull(workspaceId: string): OperationTask<BulkRepoResult[]> {
  return invokeOperation("bulk-pull", "bulk_pull", { workspaceId });
}

export function bulkOpenInIde(workspaceId: string, ide: string | null = null): Promise<BulkRepoResult[]> {
  return invoke("bulk_open_in_ide", { workspaceId, ide });
}
