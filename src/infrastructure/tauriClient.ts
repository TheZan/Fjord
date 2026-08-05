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

export function invokeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export function invokeErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return null;
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

export function getBranches(repoId: string): Promise<BranchInfo[]> {
  return invoke("get_branches", { repoId });
}

export function getTags(repoId: string): Promise<TagInfo[]> {
  return invoke("get_tags", { repoId });
}

export function getRepoStatus(repoId: string): Promise<RepoStatus> {
  return invoke("get_repo_status", { repoId });
}

export function getCommitLog(repoId: string, cursor: string | null, limit: number): Promise<CommitPage> {
  return invoke("get_commit_log", { repoId, cursor, limit });
}

export function searchCommitLog(repoId: string, query: string, limit: number): Promise<CommitSummary[]> {
  return invoke("search_commit_log", { repoId, query, limit });
}

export function globalSearch(
  query: string,
  workspaceId: string | null = null,
  limit = 30,
): Promise<GlobalSearchResult[]> {
  return invoke("global_search", { query, workspaceId, limit });
}

export function getCommitDiff(repoId: string, commitId: string): Promise<FileDiff[]> {
  return invoke("get_commit_diff", { repoId, commitId });
}

export function getFileDiff(repoId: string, commitId: string, path: string): Promise<FileDiffDetail> {
  return invoke("get_file_diff", { repoId, commitId, path });
}

export function checkoutBranch(repoId: string, branch: string): Promise<void> {
  return invoke("checkout_branch", { repoId, branch });
}

export function getWorkingChanges(repoId: string): Promise<WorkingChanges> {
  return invoke("get_working_changes", { repoId });
}

export function getWorkingFileDiff(
  repoId: string,
  path: string,
  staged: boolean,
): Promise<FileDiffDetail> {
  return invoke("get_working_file_diff", { repoId, path, staged });
}

export function createBranch(repoId: string, name: string, checkout = true): Promise<void> {
  return invoke("create_branch", { repoId, name, checkout });
}

export function getStashes(repoId: string): Promise<StashEntry[]> {
  return invoke("get_stashes", { repoId });
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
