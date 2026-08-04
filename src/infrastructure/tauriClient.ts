// Thin wrapper over Tauri's `invoke` — the only place `@tauri-apps/api`
// is imported directly. Command names must match docs/specs/ipc-commands.md
// and the `#[tauri::command]` fn names in crates/fjord-app exactly
// (verb_noun, snake_case, no translation layer).

import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "@/domain/settings";
import type { RepositoryEntry, Workspace } from "@/domain/workspace";
import type { BranchInfo, CommitPage, FileDiff, FileDiffDetail, RepoStatus } from "@/domain/git";

export function invokeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
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

export function listRepositories(workspaceId: string): Promise<RepositoryEntry[]> {
  return invoke("list_repositories", { workspaceId });
}

export function addRepository(workspaceId: string, path: string): Promise<RepositoryEntry> {
  return invoke("add_repository", { workspaceId, path });
}

export function getBranches(repoId: string): Promise<BranchInfo[]> {
  return invoke("get_branches", { repoId });
}

export function getRepoStatus(repoId: string): Promise<RepoStatus> {
  return invoke("get_repo_status", { repoId });
}

export function getCommitLog(repoId: string, cursor: string | null, limit: number): Promise<CommitPage> {
  return invoke("get_commit_log", { repoId, cursor, limit });
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

export function stageFiles(repoId: string, paths: string[]): Promise<void> {
  return invoke("stage_files", { repoId, paths });
}

export function unstageFiles(repoId: string, paths: string[]): Promise<void> {
  return invoke("unstage_files", { repoId, paths });
}

export function commitRepo(repoId: string, message: string): Promise<string> {
  return invoke("commit_repo", { repoId, message });
}

export function fetchRepo(repoId: string, remote: string | null = null): Promise<void> {
  return invoke("fetch_repo", { repoId, remote });
}

export function pullRepo(repoId: string): Promise<void> {
  return invoke("pull_repo", { repoId });
}

export function pushRepo(repoId: string): Promise<void> {
  return invoke("push_repo", { repoId });
}

export function openMergeTool(repoId: string): Promise<void> {
  return invoke("open_merge_tool", { repoId });
}
