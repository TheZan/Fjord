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

export type RepoStatus = { branch: string | null, ahead: number, behind: number, dirtyCount: number, hasConflict: boolean, };

export type RepoStatusSummary = { repoId: RepositoryId, status: RepoStatus, lastSyncedAt: string | null, };

export type BulkRepoResult = { repoId: RepositoryId, ok: boolean, error: string | null, };

export type SearchResultKind = "repository" | "branch" | "commit";

export type GlobalSearchResult = { kind: SearchResultKind, repoId: RepositoryId, workspaceId: WorkspaceId, repoName: string, repoPath: string, branch: string | null, commit: CommitSummary | null, };

export type BranchInfo = { name: string, isCurrent: boolean, isRemote: boolean, upstream: string | null, targetCommitId: CommitId, };

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

export type DiffLineKind = "context" | "addition" | "deletion";

export type DiffLine = { kind: DiffLineKind, 
/**
 * 1-based line number in the old (before) version, absent for added lines.
 */
oldLineno: number | null, 
/**
 * 1-based line number in the new (after) version, absent for removed lines.
 */
newLineno: number | null, content: string, };

export type DiffHunk = { oldStart: number, oldLines: number, newStart: number, newLines: number, lines: Array<DiffLine>, };

export type FileDiffDetail = { path: string, changeType: FileChangeType, 
/**
 * `true` if either side of the diff was detected as binary — `hunks` is empty in that case.
 */
isBinary: boolean, hunks: Array<DiffHunk>, };

export type Theme = "light" | "dark" | "system";

export type Settings = { 
/**
 * BCP-47-ish locale code, e.g. "en", "ru". See docs/specs/i18n.md.
 */
locale: string, theme: Theme, defaultIde: string | null, };

