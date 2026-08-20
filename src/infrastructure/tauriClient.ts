// Thin wrapper over Tauri's `invoke` — the only place `@tauri-apps/api`
// is imported directly. Command names must match docs/specs/ipc-commands.md
// and the `#[tauri::command]` fn names in crates/fjord-app exactly
// (verb_noun, snake_case, no translation layer).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AmendInfo,
  DestructiveAction,
  DestructivePreflight,
  DiffWhitespaceMode,
  GenerationSet,
  GitAuthPrompt,
  IgnoreRuleKind,
  IgnoreRuleOutcome,
  IgnoreRulePreview,
  InteractionTrace,
  MergeDirtyPolicy,
  MergeMode,
  MergePreflight,
  MergeResult,
  MergeSource,
  OpenTarget,
  PatchSelection,
  RepoOperationState,
  SnapshotRevalidation,
  StoredRepositorySnapshot,
  UiState,
  UiStatePatch,
} from "@/domain/generated";
import { beginIpcRequest, settleIpcRequest } from "@/infrastructure/ipcInteraction";
import type { GitConnectionTestResult, GitEnvironmentInfo, Settings } from "@/domain/settings";
import type {
  BulkRepoResult,
  CloneRepositoryRequest,
  CloneRepositoryResult,
  CreateRepositoryRequest,
  CreateRepositoryResult,
  RemoteInfo,
  RemotePushResult,
  RepoStatusSummary,
  RepositoryEntry,
  Workspace,
} from "@/domain/workspace";
import type {
  BranchInfo,
  CommitPage,
  CommitPushResult,
  CommitSummary,
  FileDiff,
  FileDiffWindow,
  GlobalSearchResult,
  ReflogPage,
  RepoStatus,
  RepositoryFilePath,
  StashEntry,
  TagInfo,
  WorkingChanges,
} from "@/domain/git";
import { writeStartupPreferences } from "@/infrastructure/startupPreferences";
import {
  observeRepositoryGenerations,
  type RepositoryGenerationScope,
} from "@/infrastructure/repositoryGenerations";

export const OPERATION_PROGRESS_EVENT = "fjord-operation-progress";
export const REPOSITORY_CHANGED_EVENT = "fjord-repository-changed";
export const AUTH_PROMPT_EVENT = "fjord-auth-prompt";

export interface RepositoryChangedEvent {
  repoId: string;
  status: boolean;
  working: boolean;
  history: boolean;
  refs: boolean;
  stashes: boolean;
  config: boolean;
  generations: GenerationSet;
  statusSummary: RepoStatusSummary | null;
}

interface GenerationEnvelope<T> {
  data: T;
  generations: GenerationSet;
}

export interface VersionedFileDiffWindow {
  data: FileDiffWindow;
  generations: GenerationSet;
}

export type OperationKind =
  | "clone"
  | "fetch"
  | "pull"
  | "push"
  | "publish"
  | "commit-push"
  | "bulk-fetch"
  | "bulk-pull"
  | "continue-operation"
  | "skip-operation"
  | "abort-operation"
  | "destructive-action"
  | "stash-checkout"
  | "merge";
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

export function invokeErrorPaths(error: unknown): string[] {
  if (!error || typeof error !== "object" || !("paths" in error) || !Array.isArray(error.paths)) {
    return [];
  }
  return error.paths.filter((path): path is string => typeof path === "string").slice(0, 100);
}

function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const sentAt = performance.now();
  const interaction = beginIpcRequest(command, sentAt);

  let request: Promise<T>;
  try {
    request = tauriInvoke<T>(
      command,
      interaction ? { ...args, interactionId: interaction.interactionId } : args,
    );
  } catch (error) {
    if (interaction) settleIpcRequest(interaction, command, performance.now());
    throw error;
  }
  if (!interaction) return request;
  return request.finally(() => settleIpcRequest(interaction, command, performance.now()));
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
  return invoke<Settings>("get_settings").then((settings) => {
    writeStartupPreferences(settings);
    return settings;
  });
}

function invokeVersioned<T>(
  command: string,
  args: Record<string, unknown>,
  repoId: string,
  scope: RepositoryGenerationScope,
  signal?: AbortSignal,
): Promise<T>;
function invokeVersioned<T>(
  command: string,
  args: Record<string, unknown>,
  repoId: string,
  scope: RepositoryGenerationScope,
  signal: AbortSignal | undefined,
  includeGenerations: true,
): Promise<GenerationEnvelope<T>>;
function invokeVersioned<T>(
  command: string,
  args: Record<string, unknown>,
  repoId: string,
  scope: RepositoryGenerationScope,
  signal?: AbortSignal,
  includeGenerations = false,
): Promise<T | GenerationEnvelope<T>> {
  return invokeAbortable<GenerationEnvelope<T>>(command, args, signal).then((response) => {
    observeRepositoryGenerations(repoId, response.generations, scope);
    return includeGenerations ? response : response.data;
  });
}

export function updateSettings(settings: Settings): Promise<Settings> {
  return invoke<Settings>("update_settings", { settings }).then((updated) => {
    writeStartupPreferences(updated);
    return updated;
  });
}

export function getUiState(): Promise<UiState> {
  return invoke("get_ui_state");
}

export function updateUiState(patch: UiStatePatch): Promise<UiState> {
  return invoke("update_ui_state", { patch });
}

export function activateAfterFirstPaint(): Promise<void> {
  return invoke("activate_after_first_paint");
}

export function revealLogFolder(): Promise<void> {
  return invoke("reveal_log_folder");
}

export function getInteractionTraces(): Promise<InteractionTrace[]> {
  return invoke("get_interaction_traces");
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

export function setRepositoryActivity(
  workspaceId: string | null,
  repoId: string | null,
): Promise<void> {
  return invoke("set_repository_activity", { workspaceId, repoId });
}

export function getRepositorySnapshot(repoId: string): Promise<StoredRepositorySnapshot | null> {
  return invoke("get_repository_snapshot", { repoId });
}

export function captureRepositorySnapshot(repoId: string): Promise<StoredRepositorySnapshot> {
  return invoke("capture_repository_snapshot", { repoId });
}

/** Snapshot persistence is explicitly outside the interaction latency path. */
export function captureRepositorySnapshotInBackground(
  repoId: string,
): Promise<StoredRepositorySnapshot> {
  return tauriInvoke("capture_repository_snapshot", { repoId });
}

export function revalidateRepositorySnapshot(repoId: string): Promise<SnapshotRevalidation> {
  return invoke("revalidate_repository_snapshot", { repoId });
}

export function addRepository(workspaceId: string, path: string): Promise<RepositoryEntry> {
  return invoke("add_repository", { workspaceId, path });
}

export function cloneRepository(
  request: CloneRepositoryRequest,
): OperationTask<CloneRepositoryResult> {
  return invokeOperation("clone", "clone_repository", { request });
}

export function createRepository(
  request: CreateRepositoryRequest,
): Promise<CreateRepositoryResult> {
  return invoke("create_repository", { request });
}

export function importRepositories(workspaceId: string, root: string): Promise<RepositoryEntry[]> {
  return invoke("import_repositories", { workspaceId, root });
}

export function removeRepository(id: string): Promise<void> {
  return invoke("remove_repository", { id });
}

export function getBranches(repoId: string, signal?: AbortSignal): Promise<BranchInfo[]> {
  return invokeVersioned("get_branches", { repoId }, repoId, "refs", signal);
}

export function invokeErrorStashRef(error: unknown): string | null {
  if (error && typeof error === "object" && "stash_ref" in error && typeof error.stash_ref === "string") {
    return error.stash_ref;
  }
  return null;
}

export function getMergePreflight(
  repoId: string,
  source: MergeSource,
  signal?: AbortSignal,
): Promise<MergePreflight> {
  return invokeVersioned("get_merge_preflight", { repoId, source }, repoId, "merge", signal);
}

export function runMergeBranch(
  repoId: string,
  source: MergeSource,
  mode: MergeMode,
  dirtyPolicy: MergeDirtyPolicy,
): OperationTask<MergeResult> {
  return invokeOperation("merge", "merge_branch", { repoId, source, mode, dirtyPolicy });
}

export function listenGitAuthPrompts(
  handler: (prompt: GitAuthPrompt) => void,
): Promise<UnlistenFn> {
  return listen<GitAuthPrompt>(AUTH_PROMPT_EVENT, (event) => handler(event.payload));
}

export function answerGitAuthPrompt(
  operationId: string,
  promptId: string,
  value: string,
): Promise<boolean> {
  return invoke("answer_git_auth_prompt", { operationId, promptId, value });
}

export function cancelGitAuthPrompt(operationId: string, promptId: string): Promise<boolean> {
  return invoke("cancel_git_auth_prompt", { operationId, promptId });
}

export function getGitEnvironment(): Promise<GitEnvironmentInfo> {
  return invoke("get_git_environment");
}

export function selectGitExecutable(path: string): Promise<GitEnvironmentInfo> {
  return invoke("select_git_executable", { path });
}

export function resetGitExecutable(): Promise<GitEnvironmentInfo> {
  return invoke("reset_git_executable");
}

export function testGitConnection(
  repoId: string,
  remote: string | null = null,
): Promise<GitConnectionTestResult> {
  return invoke("test_git_connection", { repoId, remote });
}

export function listenRepositoryChanges(
  handler: (event: RepositoryChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<RepositoryChangedEvent>(REPOSITORY_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

export function getTags(repoId: string, signal?: AbortSignal): Promise<TagInfo[]> {
  return invokeVersioned("get_tags", { repoId }, repoId, "refs", signal);
}

export function listRemotes(repoId: string): Promise<RemoteInfo[]> {
  return invoke("list_remotes", { repoId });
}

export function addRemote(repoId: string, name: string, url: string): Promise<RemoteInfo> {
  return invoke("add_remote", { repoId, name, url });
}

export function getRepoStatus(repoId: string, signal?: AbortSignal): Promise<RepoStatus> {
  return invokeVersioned("get_repo_status", { repoId }, repoId, "status", signal);
}

export function getRepoOperationState(
  repoId: string,
  signal?: AbortSignal,
): Promise<RepoOperationState> {
  return invokeVersioned("get_repo_operation_state", { repoId }, repoId, "operation", signal);
}

export function continueOperation(
  repoId: string,
  operationId: string | null = null,
): Promise<RepoOperationState> {
  return invoke("continue_operation", { repoId, operationId });
}

export function runContinueOperation(repoId: string): OperationTask<RepoOperationState> {
  return invokeOperation("continue-operation", "continue_operation", { repoId });
}

export function skipOperation(
  repoId: string,
  operationId: string | null = null,
): Promise<RepoOperationState> {
  return invoke("skip_operation", { repoId, operationId });
}

export function runSkipOperation(repoId: string): OperationTask<RepoOperationState> {
  return invokeOperation("skip-operation", "skip_operation", { repoId });
}

export function getCommitLog(
  repoId: string,
  cursor: string | null,
  limit: number,
  signal?: AbortSignal,
): Promise<CommitPage> {
  return invokeVersioned("get_commit_log", { repoId, cursor, limit }, repoId, "history", signal);
}

export function getReflog(
  repoId: string,
  refName: string | null,
  cursor: string | null,
  limit: number,
  signal?: AbortSignal,
): Promise<ReflogPage> {
  return invokeVersioned("get_reflog", { repoId, refName, cursor, limit }, repoId, "reflog", signal);
}

export function getReflogRefs(repoId: string, signal?: AbortSignal): Promise<string[]> {
  return invokeVersioned("get_reflog_refs", { repoId }, repoId, "reflog", signal);
}

export function searchCommitLog(
  repoId: string,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<CommitSummary[]> {
  return invokeVersioned("search_commit_log", { repoId, query, limit }, repoId, "history", signal);
}

export function globalSearch(
  query: string,
  workspaceId: string | null = null,
  limit = 30,
): Promise<GlobalSearchResult[]> {
  return invoke("global_search", { query, workspaceId, limit });
}

export function getCommitDiff(repoId: string, commitId: string, signal?: AbortSignal): Promise<FileDiff[]> {
  return invokeVersioned("get_commit_diff", { repoId, commitId }, repoId, "history", signal);
}

export function getRecoveryDiff(repoId: string, commitId: string, signal?: AbortSignal): Promise<FileDiff[]> {
  return invokeVersioned("get_recovery_diff", { repoId, commitId }, repoId, "reflog", signal);
}

export function getCommitFiles(
  repoId: string,
  commitId: string,
  signal?: AbortSignal,
): Promise<FileDiff[]> {
  return invokeVersioned("get_commit_files", { repoId, commitId }, repoId, "history", signal);
}

export function getFileDiff(
  repoId: string,
  commitId: string,
  path: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<FileDiffWindow> {
  return getFileDiffWithGenerations(repoId, commitId, path, offset, limit, signal).then(
    (response) => response.data,
  );
}

export function getFileDiffWithGenerations(
  repoId: string,
  commitId: string,
  path: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<VersionedFileDiffWindow> {
  return getFileDiffPage(repoId, commitId, path, offset, limit, "show", false, signal).then((response) =>
    observedDiffPage(repoId, response, "history"),
  );
}

export function getFileDiffPage(
  repoId: string,
  commitId: string,
  path: string,
  offset: number,
  limit: number,
  whitespace: DiffWhitespaceMode,
  loadAnyway: boolean,
  signal?: AbortSignal,
): Promise<VersionedFileDiffWindow> {
  return invokeAbortable<VersionedFileDiffWindow>(
    "get_file_diff",
    { repoId, commitId, path, offset, limit, whitespace, loadAnyway },
    signal,
  );
}

export function getWorkingFileDiffPage(
  repoId: string,
  path: string,
  staged: boolean,
  offset: number,
  limit: number,
  whitespace: DiffWhitespaceMode,
  loadAnyway: boolean,
  signal?: AbortSignal,
): Promise<VersionedFileDiffWindow> {
  return invokeAbortable<VersionedFileDiffWindow>(
    "get_working_file_diff",
    { repoId, path, staged, offset, limit, whitespace, loadAnyway },
    signal,
  );
}

function observedDiffPage(
  repoId: string,
  response: VersionedFileDiffWindow,
  scope: RepositoryGenerationScope,
) {
  observeRepositoryGenerations(repoId, response.generations, scope);
  return response;
}

/*
 * The page variants deliberately defer generation observation. A caller that
 * accumulates windows must first prove they belong to one snapshot; rejected
 * pages must not advance the repository generation observer.
 */
export function observeDiffPage(
  repoId: string,
  response: VersionedFileDiffWindow,
  scope: "working" | "history",
) {
  return observedDiffPage(repoId, response, scope);
}

export function checkoutBranch(repoId: string, branch: string): Promise<void> {
  return invoke("checkout_branch", { repoId, branch });
}

export function runStashAndCheckout(repoId: string, branch: string): OperationTask<string> {
  return invokeOperation("stash-checkout", "stash_and_checkout", { repoId, branch });
}

export function getWorkingChanges(repoId: string, signal?: AbortSignal): Promise<WorkingChanges> {
  return invokeVersioned("get_working_changes", { repoId }, repoId, "working", signal);
}

export function getWorkingFileDiff(
  repoId: string,
  path: string,
  staged: boolean,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<FileDiffWindow> {
  return getWorkingFileDiffWithGenerations(repoId, path, staged, offset, limit, signal).then(
    (response) => response.data,
  );
}

export function getWorkingFileDiffWithGenerations(
  repoId: string,
  path: string,
  staged: boolean,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<VersionedFileDiffWindow> {
  return getWorkingFileDiffPage(repoId, path, staged, offset, limit, "show", false, signal).then((response) =>
    observedDiffPage(repoId, response, "working"),
  );
}

export function preflightDestructiveAction(
  repoId: string,
  action: DestructiveAction,
  patchSelection: PatchSelection | null = null,
): Promise<DestructivePreflight> {
  return invoke("preflight_destructive_action", { repoId, action, patchSelection });
}

export function executeDestructiveAction(
  repoId: string,
  action: DestructiveAction,
  expectedGenerations: GenerationSet,
  confirmationToken: string,
  operationId: string | null = null,
): Promise<RepoOperationState | null> {
  return invoke("execute_destructive_action", {
    repoId,
    action,
    expectedGenerations,
    confirmationToken,
    operationId,
  });
}

export function runExecuteDestructiveAction(
  repoId: string,
  action: DestructiveAction,
  expectedGenerations: GenerationSet,
  confirmationToken: string,
): OperationTask<RepoOperationState | null> {
  return invokeOperation("destructive-action", "execute_destructive_action", {
    repoId,
    action,
    expectedGenerations,
    confirmationToken,
  });
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

export function createTag(repoId: string, name: string, target: string): Promise<void> {
  return invoke("create_tag", { repoId, name, target });
}

export function cherryPick(repoId: string, commitId: string): Promise<void> {
  return invoke("cherry_pick", { repoId, commitId });
}

export function revertCommit(repoId: string, commitId: string): Promise<void> {
  return invoke("revert_commit", { repoId, commitId });
}

export function getStashes(repoId: string, signal?: AbortSignal): Promise<StashEntry[]> {
  return invokeVersioned("get_stashes", { repoId }, repoId, "stashes", signal);
}

export function setBranchUpstream(repoId: string, branch: string, upstream: string): Promise<void> {
  return invoke("set_branch_upstream", { repoId, branch, upstream });
}

export function unsetBranchUpstream(repoId: string, branch: string): Promise<void> {
  return invoke("unset_branch_upstream", { repoId, branch });
}

export function stashPush(repoId: string, message: string | null = null): Promise<void> {
  return invoke("stash_push", { repoId, message });
}

export function openTerminal(repoId: string): Promise<void> {
  return invoke("open_terminal", { repoId });
}

export function stageFiles(repoId: string, paths: string[]): Promise<void> {
  return invoke("stage_files", { repoId, paths });
}

export function stagePatch(
  repoId: string,
  selection: PatchSelection,
  expectedGenerations: GenerationSet,
): Promise<GenerationSet> {
  return invoke<GenerationSet>("stage_patch", { repoId, selection, expectedGenerations }).then(
    (generations) => {
      observeRepositoryGenerations(repoId, generations, "working");
      return generations;
    },
  );
}

export function unstageFiles(repoId: string, paths: string[]): Promise<void> {
  return invoke("unstage_files", { repoId, paths });
}

export function unstagePatch(
  repoId: string,
  selection: PatchSelection,
  expectedGenerations: GenerationSet,
): Promise<GenerationSet> {
  return invoke<GenerationSet>("unstage_patch", { repoId, selection, expectedGenerations }).then(
    (generations) => {
      observeRepositoryGenerations(repoId, generations, "working");
      return generations;
    },
  );
}

export function discardPatch(
  repoId: string,
  action: DestructiveAction,
  selection: PatchSelection,
  expectedGenerations: GenerationSet,
  confirmationToken: string,
): Promise<GenerationSet> {
  return invoke<GenerationSet>("discard_patch", {
    repoId,
    action,
    selection,
    expectedGenerations,
    confirmationToken,
  }).then(
    (generations) => {
      observeRepositoryGenerations(repoId, generations, "working");
      return generations;
    },
  );
}

export function getAmendInfo(repoId: string): Promise<AmendInfo> {
  return invoke("get_amend_info", { repoId });
}

export function commitRepo(repoId: string, message: string, amend = false): Promise<string> {
  return invoke("commit_repo", { repoId, message, amend });
}

export function runCommitAndPushRepo(
  repoId: string,
  message: string,
  amend = false,
): OperationTask<CommitPushResult> {
  return invokeOperation("commit-push", "commit_and_push_repo", { repoId, message, amend });
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
  return invoke("push_repo", { repoId, forceWithLease: false, expectedGenerations: null, confirmationToken: null, operationId });
}

export function runPushRepo(
  repoId: string,
  forceWithLease = false,
  expectedGenerations: GenerationSet | null = null,
  confirmationToken: string | null = null,
): OperationTask<void> {
  return invokeOperation("push", "push_repo", { repoId, forceWithLease, expectedGenerations, confirmationToken });
}

export function runPushBranchToRemotes(
  repoId: string,
  remotes: string[],
): OperationTask<RemotePushResult[]> {
  return invokeOperation("push", "push_branch_to_remotes", { repoId, remotes });
}

// Publishes the current branch and sets its upstream. The remote is chosen by
// the caller; the backend never guesses one for a plain push.
export function runPublishBranch(repoId: string, remote: string | null = null): OperationTask<void> {
  return invokeOperation("publish", "publish_branch", { repoId, remote });
}

export function openMergeTool(repoId: string): Promise<void> {
  return invoke("open_merge_tool", { repoId });
}

export function openInIde(repoId: string, ide: string | null = null): Promise<void> {
  return invoke("open_in_ide", { repoId, ide });
}

export function resolveRepositoryFilePath(
  repoId: string,
  path: string,
): Promise<RepositoryFilePath> {
  return invoke("resolve_repository_file_path", { repoId, path });
}

export function openRepositoryPath(
  repoId: string,
  path: string,
  target: OpenTarget,
): Promise<void> {
  return invoke("open_repository_path", { repoId, path, target });
}

export function revealRepositoryPath(repoId: string, path: string): Promise<void> {
  return invoke("reveal_repository_path", { repoId, path });
}

export function previewIgnoreRule(
  repoId: string,
  path: string,
  ruleKind: IgnoreRuleKind,
): Promise<IgnoreRulePreview> {
  return invoke("preview_ignore_rule", { repoId, path, ruleKind });
}

export function addIgnoreRule(
  repoId: string,
  path: string,
  ruleKind: IgnoreRuleKind,
): Promise<IgnoreRuleOutcome> {
  return invoke("add_ignore_rule", { repoId, path, ruleKind });
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
