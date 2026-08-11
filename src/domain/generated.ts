// Generated from crates/fjord-domain. Do not edit by hand.
// Regenerate with: FJORD_UPDATE_DOMAIN_TYPES=1 cargo test -p fjord-domain export_types -- --exact

export type WorkspaceId = string;

export type RepositoryId = string;

export type Workspace = { id: WorkspaceId, name: string, sortOrder: number, };

export type RepositoryEntry = { id: RepositoryId, workspaceId: WorkspaceId, name: string, 
/**
 * Absolute path, platform-native separators. Comparison/dedup goes
 * through `fjord-fs`'s normalization helper, never a raw string compare
 * — see docs/specs/data-model.md.
 */
path: string, sortOrder: number, };

export type GenerationSet = { workingTree: number, refs: number, history: number, stash: number, config: number, };

export type RepositorySnapshot = { status: RepoStatus, branches: Array<BranchInfo>, tags: Array<TagInfo>, firstHistoryPage: CommitPage, workingChanges: WorkingChanges, generations: GenerationSet, };

export type StoredRepositorySnapshot = { repoId: RepositoryId, snapshot: RepositorySnapshot, capturedAt: string, validated: boolean, };

export type SnapshotRevalidation = { snapshot: StoredRepositorySnapshot, changed: boolean, };

export type RepoStatus = { branch: string | null, ahead: number, behind: number, dirtyCount: number, hasConflict: boolean, };

export type RepoStatusSummary = { repoId: RepositoryId, status: RepoStatus, lastSyncedAt: string | null, };

export type BulkRepoResult = { repoId: RepositoryId, ok: boolean, error: string | null, };

export type SearchResultKind = "repository" | "branch" | "commit";

export type GlobalSearchResult = { kind: SearchResultKind, repoId: RepositoryId, workspaceId: WorkspaceId, repoName: string, repoPath: string, branch: string | null, commit: CommitSummary | null, };

export type BranchInfo = { name: string, isCurrent: boolean, isRemote: boolean, upstream: string | null, targetCommitId: CommitId, };

export type RemoteRef = { name: string, target: string, symbolicTarget: string | null, };

export type TagInfo = { name: string, targetCommitId: CommitId, };

export type StashEntry = { index: number, message: string, };

export type CommitId = string;

export type CommitSummary = { id: CommitId, parentIds: Array<CommitId>, message: string, authorName: string, authorEmail: string, authoredAt: string, refs: Array<string>, };

export type LogCursor = string;

export type CommitPage = { commits: Array<CommitSummary>, nextCursor: LogCursor | null, };

export type FileChangeType = "added" | "modified" | "deleted" | "renamed";

export type FileDiff = { path: string, changeType: FileChangeType, additions: number, deletions: number, };

export type WorkingFile = { path: string, changeType: FileChangeType, 
/**
 * `true` when the entry is an unresolved merge conflict.
 */
conflicted: boolean, };

export type WorkingChanges = { staged: Array<WorkingFile>, unstaged: Array<WorkingFile>, };

export type PatchSource = "worktree" | "index";

export type HunkSelection = { oldStart: number, oldLines: number, newStart: number, newLines: number,
/**
 * Empty selects the whole hunk. Otherwise these are zero-based indices
 * into the complete hunk `lines` array, not a window-local slice.
 */
lines: Array<number>, };

export type PatchSelection = {
/**
 * Path exactly as reported by [`WorkingChanges`].
 */
path: string, source: PatchSource, hunks: Array<HunkSelection>,
/**
 * SHA-256 digest of the complete rendered diff, including source.
 */
baseDigest: string, };

export type DiscardSelection = { "kind": "file", path: string, } | { "kind": "hunk", path: string, oldStart: number, oldLines: number, newStart: number, newLines: number, } | { "kind": "lines", path: string, oldStart: number, oldLines: number, newStart: number, newLines: number, lines: Array<number>, };

export type DestructiveAction = { "kind": "discard", selection: DiscardSelection, } | { "kind": "forceWithLease", remote: string, refName: string, expectedOid: CommitId, };

export type Recoverability = "reflog" | "stash" | "notRecoverable";

export type Consequence = { "kind": "modifiedFilesDiscarded", count: number, sample: Array<string>, } | { "kind": "modifiedLinesDiscarded", path: string, count: number, } | { "kind": "untrackedFilesDeleted", count: number, sample: Array<string>, } | { "kind": "stagedChangesDiscarded", count: number, } | { "kind": "commitsUnreachable", count: number, sample: Array<CommitSummary>, } | { "kind": "branchDeleted", name: string, unmergedInto: string | null, } | { "kind": "stashEntryConsumed", index: number, message: string, } | { "kind": "remoteRefUpdated", remote: string, refName: string, droppedCommits: number, };

export type DestructivePreflight = { action: DestructiveAction, consequences: Array<Consequence>, recoverable: Recoverability, blockers: Array<string>, generations: GenerationSet, confirmationToken: string | null, };

export type DiffLineKind = "context" | "addition" | "deletion";

export type DiffLineEnding = "lf" | "crlf" | "none";

export type DiffLine = { kind: DiffLineKind,
/**
 * 1-based line number in the old (before) version, absent for added lines.
 */
oldLineno: number | null,
/**
 * 1-based line number in the new (after) version, absent for removed lines.
 */
newLineno: number | null, content: string,
/**
 * Exact terminator when the backend exposes it; commit-history diffs may
 * leave this unknown, while patchable working diffs always provide it.
 */
lineEnding: DiffLineEnding | null, };

export type DiffHunk = { oldStart: number, oldLines: number, newStart: number, newLines: number, lines: Array<DiffLine>, };

export type FileDiffDetail = { path: string, changeType: FileChangeType,
/**
 * Git file modes when available. Patch generation uses these for added
 * and deleted files; mode-only changes remain unsupported in Phase 8.
 */
oldMode: number | null, newMode: number | null,
/**
 * `true` if either side of the diff was detected as binary — `hunks` is empty in that case.
 */
isBinary: boolean, hunks: Array<DiffHunk>, };

export type FileDiffWindow = { path: string, changeType: FileChangeType, oldMode: number | null, newMode: number | null, isBinary: boolean, tooLarge: boolean, fileBytes: number, hunks: Array<DiffHunk>, totalHunks: number, totalLines: number, truncated: boolean, nextOffset: number | null,
/**
 * Present only for working-file diff state. It covers the full
 * diff even when this response contains one bounded window.
 */
baseDigest: string | null, };

export type Theme = "light" | "dark" | "system";

export type GitExecutableSource = "settings" | "path" | "standard-location";

export type GitExecutable = { path: string, version: string, source: GitExecutableSource, };

export type CredentialHelperInfo = { value: string, source: string, };

export type GitEnvironmentInfo = { executablePath: string | null, version: string | null, executableSource: GitExecutableSource | null, configuredPathValid: boolean, credentialHelpers: Array<CredentialHelperInfo>, sshCommand: string | null, sshAgentAvailable: boolean, proxyConfigured: boolean, 
/**
 * Whether the bundled askpass sidecar was found. Without it Git cannot
 * prompt through Fjord, so a packaging failure would otherwise surface as
 * an authentication failure with no explanation. Filled in by the
 * application layer, which owns sidecar resolution.
 */
askpassAvailable: boolean, };

export type GitConnectionProtocol = "https" | "ssh" | "local" | "other";

export type GitConnectionTestResult = { success: boolean, durationMs: bigint, remote: string, protocol: GitConnectionProtocol, referenceCount: number, };

export type GitAuthPromptKind = "username" | "secret" | "confirmation" | "unknown";

export type GitAuthPrompt = { operationId: string, promptId: string, prompt: string, kind: GitAuthPromptKind, repositoryName: string | null, operationKind: string | null, };

export type InteractionSpan = { phase: string, operation: string, durationMicros: number, counts: { [key in string]: number }, };

export type InteractionTrace = { interactionId: string, spans: Array<InteractionSpan>, };

export type Settings = { 
/**
 * BCP-47-ish locale code, e.g. "en", "ru". See docs/specs/i18n.md.
 */
locale: string, theme: Theme, defaultIde: string | null, autoFetch: boolean, performanceDiagnostics: boolean, gitExecutablePath: string | null, };

export type UiDiffMode = "unified" | "split";

export type UiFileViewMode = "path" | "tree";

export type UiOverviewFilter = "attention" | "behind";

export type SidebarUiState = { width: number | null, collapsedWorkspaces: Array<WorkspaceId>, };

export type RepoUiState = { treeWidth: number | null, inspectorWidth: number | null, diffMode: UiDiffMode, fileViewMode: UiFileViewMode, };

export type SelectionUiState = { workspaceId: WorkspaceId | null, repositoryId: RepositoryId | null, };

export type OverviewUiState = { filters: Array<UiOverviewFilter>, };

export type UiState = { version: number, sidebar: SidebarUiState, repo: RepoUiState, selection: SelectionUiState, overview: OverviewUiState, };

export type SidebarUiStatePatch = { width: number | null, collapsedWorkspaces: Array<WorkspaceId> | null, };

export type RepoUiStatePatch = { treeWidth: number | null, inspectorWidth: number | null, diffMode: UiDiffMode | null, fileViewMode: UiFileViewMode | null, };

export type SelectionUiStatePatch = { workspaceId: WorkspaceId | null, repositoryId: RepositoryId | null, };

export type OverviewUiStatePatch = { filters: Array<UiOverviewFilter> | null, };

export type UiStatePatch = { sidebar: SidebarUiStatePatch | null, repo: RepoUiStatePatch | null, selection: SelectionUiStatePatch | null, overview: OverviewUiStatePatch | null, };

