//! Core entities and value objects shared across Fjord.
//!
//! This crate has no knowledge of Tauri, SQLite, or any Git engine — see
//! `docs/SDD.md` §5.1. It exists so `fjord-services` has something to
//! operate on without depending on infrastructure.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct WorkspaceId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct RepositoryId(pub Uuid);

impl WorkspaceId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for WorkspaceId {
    fn default() -> Self {
        Self::new()
    }
}

impl RepositoryId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for RepositoryId {
    fn default() -> Self {
        Self::new()
    }
}

// `rename_all = "camelCase"` on every multi-field type below is what lets
// the frontend (docs/specs/ipc-commands.md) use idiomatic camelCase without
// a translation layer — single-field newtypes (WorkspaceId, CommitId, ...)
// serialize transparently and don't need it.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RepositoryEntry {
    pub id: RepositoryId,
    pub workspace_id: WorkspaceId,
    pub name: String,
    /// Absolute path, platform-native separators. Comparison/dedup goes
    /// through `fjord-fs`'s normalization helper, never a raw string compare
    /// — see docs/specs/data-model.md.
    #[ts(type = "string")]
    pub path: PathBuf,
    pub sort_order: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CloneRepositoryRequest {
    pub workspace_id: WorkspaceId,
    pub url: String,
    #[ts(type = "string")]
    pub destination_parent: PathBuf,
    pub directory_name: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CloneRepositoryResult {
    pub repository: RepositoryEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CreateRepositoryRequest {
    pub workspace_id: WorkspaceId,
    #[ts(type = "string")]
    pub destination_parent: PathBuf,
    pub directory_name: String,
    pub initial_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CreateRepositoryResult {
    pub repository: RepositoryEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: Option<String>,
}

/// Result of pushing the current branch to one explicitly selected remote.
/// Individual remote failures are data so one rejected destination does not
/// hide successful pushes to the others.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RemotePushResult {
    pub remote: String,
    pub ok: bool,
    pub error_code: Option<String>,
}

/// Monotonic in-memory versions of independently observable repository data.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GenerationSet {
    #[ts(type = "number")]
    pub working_tree: u64,
    #[ts(type = "number")]
    pub refs: u64,
    #[ts(type = "number")]
    pub history: u64,
    #[ts(type = "number")]
    pub stash: u64,
    #[ts(type = "number")]
    pub config: u64,
}

/// A durable, read-only projection used to paint a repository before the
/// first live Git refresh after startup completes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub status: RepoStatus,
    pub operation_state: RepoOperationState,
    pub branches: Vec<BranchInfo>,
    pub tags: Vec<TagInfo>,
    pub first_history_page: CommitPage,
    pub working_changes: WorkingChanges,
    pub generations: GenerationSet,
}

/// A loaded row is marked unvalidated until live Git state has been compared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct StoredRepositorySnapshot {
    pub repo_id: RepositoryId,
    pub snapshot: RepositorySnapshot,
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub captured_at: OffsetDateTime,
    pub validated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SnapshotRevalidation {
    pub snapshot: StoredRepositorySnapshot,
    pub changed: bool,
}

/// Live status for a single repository, as returned by `GitBackend::status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty_count: u32,
    pub has_conflict: bool,
}

/// A control Git can perform for the operation currently recorded on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum OperationControl {
    Continue,
    Skip,
    Abort,
}

/// The on-disk protocol used by an in-progress rebase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum RebaseKind {
    Apply,
    Merge,
    Interactive,
}

/// Git state derived from marker files in the repository's resolved git-dir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RepoOperation {
    Normal,
    Merge {
        head: String,
        incoming: Vec<String>,
    },
    Rebase {
        rebase_kind: RebaseKind,
        onto: String,
        current: u32,
        total: u32,
        head_name: Option<String>,
    },
    CherryPick {
        commit: String,
    },
    Revert {
        commit: String,
    },
    Bisect {
        good: u32,
        bad: u32,
    },
    Detached {
        head: String,
    },
    UnbornBranch,
}

/// Complete operation state used by the repository safety UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RepoOperationState {
    pub operation: RepoOperation,
    pub conflicted_paths: Vec<String>,
    pub available: Vec<OperationControl>,
    pub detected_externally: bool,
}

/// The cached counterpart of `RepoStatus` — always safe to drop and rebuild
/// from a live `RepoStatus` call. See docs/specs/data-model.md.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RepoStatusSummary {
    pub repo_id: RepositoryId,
    pub status: RepoStatus,
    #[serde(with = "time::serde::rfc3339::option")]
    #[ts(type = "string | null")]
    pub last_synced_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct BulkRepoResult {
    pub repo_id: RepositoryId,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum SearchResultKind {
    Repository,
    Branch,
    Commit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GlobalSearchResult {
    pub kind: SearchResultKind,
    pub repo_id: RepositoryId,
    pub workspace_id: WorkspaceId,
    pub repo_name: String,
    #[ts(type = "string")]
    pub repo_path: PathBuf,
    pub branch: Option<String>,
    pub commit: Option<CommitSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub target_commit_id: CommitId,
}

/// The only reference kinds accepted by the branch-integration contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum MergeSourceKind {
    LocalBranch,
    RemoteTracking,
}

/// A merge source is always a canonical, fully-qualified Git ref name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct MergeSource {
    pub ref_name: String,
    pub kind: MergeSourceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum MergeMode {
    Default,
    FastForwardOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum MergeDirtyPolicy {
    Refuse,
    StashFirst,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MergePrediction {
    AlreadyUpToDate,
    FastForward { commits: u32 },
    MergeCommit { ahead: u32, behind: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct MergeDirtyState {
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub would_overwrite: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct MergePreflight {
    pub source: MergeSource,
    pub source_label: String,
    pub source_commit: CommitId,
    pub target_branch: String,
    pub target_commit: CommitId,
    pub prediction: MergePrediction,
    pub dirty: MergeDirtyState,
    pub blockers: Vec<String>,
    pub generations: GenerationSet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MergeOutcome {
    AlreadyUpToDate,
    FastForwarded { head: CommitId },
    Merged { commit: CommitId },
    Conflicted { state: RepoOperationState },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct MergeResult {
    pub outcome: MergeOutcome,
    pub source: MergeSource,
    pub source_label: String,
    pub target_branch: String,
    pub stash_ref: Option<String>,
    pub generations: GenerationSet,
}

/// `git merge --squash`: stages the combined diff (or leaves it conflicted)
/// without creating a merge commit or moving any ref. See P10-MERGE-03.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SquashMergeOutcome {
    AlreadyUpToDate,
    Staged { message: String },
    Conflicted { paths: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SquashMergeResult {
    pub outcome: SquashMergeOutcome,
    pub source: MergeSource,
    pub source_label: String,
    pub target_branch: String,
    /// `HEAD` before the squash ran — unmoved by any outcome. Lets the
    /// caller offer a plain Reset (Hard) to this commit as the discard path,
    /// reusing the existing destructive-preflight `Reset` action rather than
    /// inventing a second abort mechanism.
    pub target_commit: CommitId,
    pub stash_ref: Option<String>,
    pub generations: GenerationSet,
}

/// A reference advertised by a remote repository. `symbolic_target` is set
/// for entries such as `HEAD` returned by `git ls-remote --symref`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RemoteRef {
    pub name: String,
    pub target: String,
    pub symbolic_target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub target_commit_id: CommitId,
}

/// The stash commit's object id. This is deliberately distinct from
/// `CommitId`: a stash object is not ordinary checkout/history input.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct StashId(pub String);

/// One repository-derived entry of the stash stack. `id` is immutable;
/// `index` and `ref_name` are current display positions recomputed per read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct StashEntry {
    pub id: StashId,
    pub index: u32,
    pub ref_name: String,
    pub message: String,
    pub title: String,
    pub base: CommitId,
    pub branch: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub created_at: OffsetDateTime,
    pub files_changed: u32,
    pub has_index_state: bool,
    pub has_untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CommitId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CommitSummary {
    pub id: CommitId,
    pub parent_ids: Vec<CommitId>,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub authored_at: OffsetDateTime,
    pub refs: Vec<String>,
}

/// Opaque pagination cursor for commit-log and reflog reads. Callers must not
/// parse or construct one themselves — round-trip the page's `next_cursor`.
/// See docs/specs/git-backend.md and docs/specs/ipc-commands.md.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LogCursor(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CommitPage {
    pub commits: Vec<CommitSummary>,
    pub next_cursor: Option<LogCursor>,
}

/// One newest-first entry from a Git reference log. `index` is the stable
/// display position for the snapshot being paged (`HEAD@{0}`, `HEAD@{1}`, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub index: u32,
    pub old_id: CommitId,
    pub new_id: CommitId,
    pub committer_name: String,
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub timestamp: OffsetDateTime,
    pub operation: String,
    pub message: String,
    pub commit: Option<CommitSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ReflogPage {
    pub entries: Vec<ReflogEntry>,
    pub next_cursor: Option<LogCursor>,
}

/// Data required before the commit panel can offer an amend action.
/// `published_upstream` is present only when the current `HEAD` is reachable
/// from the current branch's locally known upstream ref.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AmendInfo {
    pub message: String,
    pub published_upstream: Option<String>,
}

/// Composite outcome returned once commit creation has succeeded. A push
/// failure never rolls the commit back, so it is data rather than a rejected
/// command result and the UI can report both phases honestly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CommitPushResult {
    pub commit_id: String,
    pub commit_succeeded: bool,
    pub push_succeeded: bool,
    pub push_error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum FileChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub change_type: FileChangeType,
    pub additions: u32,
    pub deletions: u32,
}

/// One entry of the working directory as the commit panel sees it. A file
/// that is partially staged legitimately appears in both lists of
/// [`WorkingChanges`], which is why this carries no "staged" flag of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkingFile {
    pub path: String,
    pub change_type: FileChangeType,
    /// `true` when the path already has an index entry.
    #[serde(default = "tracked_by_default")]
    pub tracked: bool,
    /// `true` when the entry is an unresolved merge conflict.
    pub conflicted: bool,
}

const fn tracked_by_default() -> bool {
    true
}

/// Split of the working directory into what a commit would include (`staged`)
/// and what it would leave behind (`unstaged`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkingChanges {
    pub staged: Vec<WorkingFile>,
    pub unstaged: Vec<WorkingFile>,
}

/// Which repository side a patch selection was rendered from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum PatchSource {
    /// Index-to-working-tree diff, used for staging and discarding.
    Worktree,
    /// HEAD-to-index diff, used for unstaging.
    Index,
}

/// Logical identity of one Working Changes row. The source is part of the
/// identity because a partially staged path appears in both sections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct WorkingFileTarget {
    pub path: String,
    pub source: PatchSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RepositoryFilePath {
    pub relative: String,
    #[ts(type = "string")]
    pub absolute: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OpenTarget {
    ConfiguredEditor { line: Option<u32> },
    DefaultApplication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum IgnoreRuleKind {
    File,
    Extension,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct IgnoreRulePreview {
    pub rule: String,
    pub already_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum IgnoreRuleOutcome {
    Added,
    AlreadyPresent,
}

/// Coordinates for one selected hunk in the complete rendered diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct HunkSelection {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Empty selects the whole hunk. Otherwise these are zero-based indices
    /// into the complete hunk `lines` array, not a window-local slice.
    pub lines: Vec<u32>,
}

/// A verified line-coordinate selection from a working-file diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PatchSelection {
    /// Path exactly as reported by [`WorkingChanges`].
    pub path: String,
    pub source: PatchSource,
    pub hunks: Vec<HunkSelection>,
    /// SHA-256 digest of the complete rendered diff, including source.
    pub base_digest: String,
}

/// The part of an unstaged file that a future discard command will reverse.
/// Coordinates deliberately match a rendered diff hunk so confirmation can be
/// recomputed without trusting a caller-supplied line count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiscardSelection {
    File {
        path: String,
    },
    Hunk {
        path: String,
        old_start: u32,
        old_lines: u32,
        new_start: u32,
        new_lines: u32,
    },
    Lines {
        path: String,
        old_start: u32,
        old_lines: u32,
        new_start: u32,
        new_lines: u32,
        // Zero-based indices in the matching hunk's complete `lines` array.
        lines: Vec<u32>,
    },
}

impl DiscardSelection {
    pub fn path(&self) -> &str {
        match self {
            Self::File { path } | Self::Hunk { path, .. } | Self::Lines { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// One exhaustive destructive-action model shared by preflight and execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DestructiveAction {
    Discard { selection: DiscardSelection },
    ForceWithLease,
    Reset { commit_id: String, mode: ResetMode },
    DeleteBranch { name: String },
    DeleteRemoteBranch { remote: String, branch: String },
    DeleteTag { name: String },
    StashPop { index: u32 },
    CheckoutDiscard { branch: String },
    AbortOperation,
    RecoveryRestore { commit_id: String },
    DeleteFile { path: String },
}

/// Authoritative lease facts resolved by the backend. These are display-only
/// over IPC; force-push execution accepts only the backend confirmation token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct ForceWithLeaseDetails {
    pub remote: String,
    pub ref_name: String,
    pub expected_oid: CommitId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum Recoverability {
    Reflog,
    Stash,
    NotRecoverable,
    /// The content is still in `HEAD` and can be restored from there. Used
    /// only where an action's *complete* consequence set leaves nothing else
    /// uncommitted lost — see `DestructiveAction::DeleteFile`.
    Committed,
}

/// A concrete, bounded consequence. Every sample is capped by the service at
/// five entries while `count` remains the exact total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Consequence {
    ModifiedFilesDiscarded {
        count: u32,
        sample: Vec<String>,
    },
    ModifiedLinesDiscarded {
        path: String,
        count: u32,
    },
    UntrackedFilesDeleted {
        count: u32,
        sample: Vec<String>,
    },
    StagedChangesDiscarded {
        count: u32,
    },
    CommitsUnreachable {
        count: u32,
        sample: Vec<CommitSummary>,
    },
    BranchDeleted {
        name: String,
        unmerged_into: Option<String>,
    },
    TagDeleted {
        name: String,
        target_commit_id: Option<CommitId>,
    },
    StashEntryConsumed {
        index: u32,
        message: String,
    },
    RemoteRefUpdated {
        remote: String,
        ref_name: String,
        dropped_commits: u32,
    },
    FileRemoved {
        path: String,
        tracked: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DestructivePreflight {
    pub action: DestructiveAction,
    pub consequences: Vec<Consequence>,
    pub recoverable: Recoverability,
    // Stable reason keys. The frontend owns their localized wording.
    pub blockers: Vec<String>,
    // Captured only after consequence computation completed without a
    // generation change; confirmation must present this stamp to execution.
    pub generations: GenerationSet,
    // Present only for force-with-lease and resolved from backend Git state.
    pub force_with_lease: Option<ForceWithLeaseDetails>,
    // Backend-issued bearer proof for this exact destructive scope. Blocked
    // preflights do not receive a confirmation.
    pub confirmation_token: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
}

/// The terminator carried by a diff line. Patch construction must preserve it:
/// treating CRLF or a missing final newline as ordinary LF can make a selected
/// patch apply to different bytes than the user reviewed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum DiffLineEnding {
    Lf,
    Crlf,
    None,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum DiffWhitespaceMode {
    #[default]
    Show,
    IgnoreTrailing,
    IgnoreAll,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// 1-based line number in the old (before) version, absent for added lines.
    pub old_lineno: Option<u32>,
    /// 1-based line number in the new (after) version, absent for removed lines.
    pub new_lineno: Option<u32>,
    pub content: String,
    /// Exact terminator when the backend exposes it; commit-history diffs may
    /// leave this unknown, while patchable working diffs always provide it.
    pub line_ending: Option<DiffLineEnding>,
}

/// One `@@ -old_start,old_lines +new_start,new_lines @@` block of a unified diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

/// Full line-by-line diff for a single file, as returned by `GitBackend::file_diff`.
/// See docs/tasks.md P1-05.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FileDiffDetail {
    pub path: String,
    pub change_type: FileChangeType,
    /// Git file modes when available. Patch generation uses these for added
    /// and deleted files; mode-only changes remain unsupported in Phase 8.
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
    /// `true` if either side of the diff was detected as binary — `hunks` is empty in that case.
    pub is_binary: bool,
    pub hunks: Vec<DiffHunk>,
}

/// A bounded slice of a file diff. `offset` and `next_offset` count diff lines
/// (hunk headers are metadata and do not consume the window).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FileDiffWindow {
    pub path: String,
    pub change_type: FileChangeType,
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
    pub is_binary: bool,
    pub too_large: bool,
    #[ts(type = "number")]
    pub file_bytes: u64,
    pub hunks: Vec<DiffHunk>,
    pub total_hunks: u32,
    pub total_lines: u32,
    /// Authoritative zero-based diff-line offset served by this response.
    pub offset: u32,
    pub truncated: bool,
    pub next_offset: Option<u32>,
    /// Present only for working-file diff state. It covers the full
    /// diff even when this response contains one bounded window.
    pub base_digest: Option<String>,
}

impl FileDiffDetail {
    pub fn into_window(self, offset: u32, limit: u32) -> FileDiffWindow {
        let total_hunks = self.hunks.len() as u32;
        let total_lines = self.hunks.iter().map(|hunk| hunk.lines.len() as u32).sum();
        let start = offset.min(total_lines);
        let end = start.saturating_add(limit).min(total_lines);
        let mut cursor = 0_u32;
        let mut hunks = Vec::new();

        for mut hunk in self.hunks {
            let hunk_start = cursor;
            let hunk_end = cursor.saturating_add(hunk.lines.len() as u32);
            cursor = hunk_end;
            if hunk_end <= start || hunk_start >= end {
                continue;
            }
            let local_start = start.saturating_sub(hunk_start) as usize;
            let local_end = (end - hunk_start).min(hunk.lines.len() as u32) as usize;
            hunk.lines = hunk.lines[local_start..local_end].to_vec();
            hunks.push(hunk);
        }

        let truncated = end < total_lines;
        FileDiffWindow {
            path: self.path,
            change_type: self.change_type,
            old_mode: self.old_mode,
            new_mode: self.new_mode,
            is_binary: self.is_binary,
            too_large: false,
            file_bytes: 0,
            hunks,
            total_hunks,
            total_lines,
            offset: start,
            truncated,
            next_offset: truncated.then_some(end),
            base_digest: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum GitExecutableSource {
    Settings,
    Path,
    StandardLocation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitExecutable {
    #[ts(type = "string")]
    pub path: PathBuf,
    pub version: String,
    pub source: GitExecutableSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CredentialHelperInfo {
    pub value: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitEnvironmentInfo {
    #[ts(type = "string | null")]
    pub executable_path: Option<PathBuf>,
    pub version: Option<String>,
    pub executable_source: Option<GitExecutableSource>,
    pub configured_path_valid: bool,
    pub credential_helpers: Vec<CredentialHelperInfo>,
    pub ssh_command: Option<String>,
    pub ssh_agent_available: bool,
    pub proxy_configured: bool,
    /// Whether the bundled askpass sidecar was found. Without it Git cannot
    /// prompt through Fjord, so a packaging failure would otherwise surface as
    /// an authentication failure with no explanation. Filled in by the
    /// application layer, which owns sidecar resolution.
    pub askpass_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum GitConnectionProtocol {
    Https,
    Ssh,
    Local,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitConnectionTestResult {
    pub success: bool,
    pub duration_ms: u64,
    pub remote: String,
    pub protocol: GitConnectionProtocol,
    pub reference_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum GitAuthPromptKind {
    Username,
    Secret,
    Confirmation,
    Unknown,
}

/// A credential prompt safe to send to the frontend. Broker address and
/// authentication token deliberately never cross this boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct GitAuthPrompt {
    pub operation_id: String,
    pub prompt_id: String,
    pub prompt: String,
    pub kind: GitAuthPromptKind,
    pub repository_name: Option<String>,
    pub operation_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct Settings {
    /// BCP-47-ish locale code, e.g. "en", "ru". See docs/specs/i18n.md.
    pub locale: String,
    pub theme: Theme,
    pub default_ide: Option<String>,
    pub auto_fetch: bool,
    pub performance_diagnostics: bool,
    #[ts(type = "string | null")]
    pub git_executable_path: Option<PathBuf>,
    /// A Git difftool **name** only — never a path, shell command, or command
    /// line. `None` means "let Git resolve `diff.tool` /
    /// `difftool.<name>.cmd`"; `Some("meld")` means invoke `git difftool
    /// --tool=meld`. See docs/specs/working-tree-and-diff.md §6.4.
    pub diff_tool: Option<String>,
}

/// Whether `name` is a Git difftool name rather than a path or command line.
///
/// This is shared by the settings and Git backend boundaries so values that
/// bypass persisted settings are held to the same contract before Git is run.
pub fn is_valid_diff_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            locale: "en".to_string(),
            theme: Theme::System,
            default_ide: None,
            auto_fetch: false,
            performance_diagnostics: false,
            git_executable_path: None,
            diff_tool: None,
        }
    }
}

pub const UI_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SidebarUiState {
    pub width: Option<f64>,
    pub collapsed_workspaces: Vec<WorkspaceId>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RepoUiState {
    pub tree_width: Option<f64>,
    pub inspector_width: Option<f64>,
    pub diff_mode: UiDiffMode,
    pub file_view_mode: UiFileViewMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum UiDiffMode {
    #[default]
    Unified,
    Split,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum UiFileViewMode {
    #[default]
    Path,
    Tree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum UiOverviewFilter {
    Attention,
    Behind,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SelectionUiState {
    pub workspace_id: Option<WorkspaceId>,
    pub repository_id: Option<RepositoryId>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct OverviewUiState {
    pub filters: Vec<UiOverviewFilter>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct UiState {
    pub version: u32,
    pub sidebar: SidebarUiState,
    pub repo: RepoUiState,
    pub selection: SelectionUiState,
    pub overview: OverviewUiState,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            version: UI_STATE_VERSION,
            sidebar: SidebarUiState::default(),
            repo: RepoUiState::default(),
            selection: SelectionUiState::default(),
            overview: OverviewUiState::default(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RepoUiStatePatch {
    pub tree_width: Option<f64>,
    pub inspector_width: Option<f64>,
    pub diff_mode: Option<UiDiffMode>,
    pub file_view_mode: Option<UiFileViewMode>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SidebarUiStatePatch {
    pub width: Option<f64>,
    pub collapsed_workspaces: Option<Vec<WorkspaceId>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SelectionUiStatePatch {
    pub workspace_id: Option<WorkspaceId>,
    pub repository_id: Option<RepositoryId>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct OverviewUiStatePatch {
    pub filters: Option<Vec<UiOverviewFilter>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct UiStatePatch {
    pub sidebar: Option<SidebarUiStatePatch>,
    pub repo: Option<RepoUiStatePatch>,
    pub selection: Option<SelectionUiStatePatch>,
    pub overview: Option<OverviewUiStatePatch>,
}

impl UiState {
    pub fn apply(&mut self, patch: UiStatePatch) {
        if let Some(sidebar) = patch.sidebar {
            if let Some(width) = sidebar.width {
                self.sidebar.width = Some(width);
            }
            if let Some(collapsed) = sidebar.collapsed_workspaces {
                self.sidebar.collapsed_workspaces = collapsed;
            }
        }
        if let Some(repo) = patch.repo {
            if let Some(width) = repo.tree_width {
                self.repo.tree_width = Some(width);
            }
            if let Some(width) = repo.inspector_width {
                self.repo.inspector_width = Some(width);
            }
            if let Some(mode) = repo.diff_mode {
                self.repo.diff_mode = mode;
            }
            if let Some(mode) = repo.file_view_mode {
                self.repo.file_view_mode = mode;
            }
        }
        if let Some(selection) = patch.selection {
            self.selection.workspace_id = selection.workspace_id;
            self.selection.repository_id = selection.repository_id;
        }
        if let Some(overview) = patch.overview {
            if let Some(filters) = overview.filters {
                self.overview.filters = filters;
            }
        }
        self.version = UI_STATE_VERSION;
    }
}

/// One duration measured entirely by the Rust clock. The deliberately narrow
/// shape cannot carry repository paths, names, or file/diff content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct InteractionSpan {
    pub phase: String,
    pub operation: String,
    #[ts(type = "number")]
    pub duration_micros: u64,
    pub counts: BTreeMap<String, u32>,
}

/// Completed backend spans grouped by the opaque id minted by the WebView.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct InteractionTrace {
    pub interaction_id: String,
    pub spans: Vec<InteractionSpan>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_summary_serializes_authored_at_as_rfc3339() {
        let commit = CommitSummary {
            id: CommitId("deadbeef".to_string()),
            parent_ids: vec![],
            message: "Initial commit".to_string(),
            author_name: "A. Developer".to_string(),
            author_email: "dev@example.com".to_string(),
            authored_at: OffsetDateTime::from_unix_timestamp(0).unwrap(),
            refs: vec![],
        };

        let value = serde_json::to_value(commit).unwrap();

        assert_eq!(value["authoredAt"], "1970-01-01T00:00:00Z");
    }

    #[test]
    fn stash_entry_serializes_the_rich_camel_case_contract() {
        let entry = StashEntry {
            id: StashId("1111111111111111111111111111111111111111".to_string()),
            index: 2,
            ref_name: "stash@{2}".to_string(),
            message: "On main: work".to_string(),
            title: "work".to_string(),
            base: CommitId("0000000000000000000000000000000000000000".to_string()),
            branch: Some("main".to_string()),
            created_at: OffsetDateTime::UNIX_EPOCH,
            files_changed: 3,
            has_index_state: true,
            has_untracked: false,
        };

        let value = serde_json::to_value(entry).unwrap();

        assert_eq!(value["id"], "1111111111111111111111111111111111111111");
        assert_eq!(value["refName"], "stash@{2}");
        assert_eq!(value["createdAt"], "1970-01-01T00:00:00Z");
        assert_eq!(value["filesChanged"], 3);
        assert_eq!(value["hasIndexState"], true);
        assert_eq!(value["hasUntracked"], false);
    }

    #[test]
    fn repo_status_summary_serializes_last_synced_at_as_rfc3339() {
        let summary = RepoStatusSummary {
            repo_id: RepositoryId::new(),
            status: RepoStatus {
                branch: Some("main".to_string()),
                ahead: 0,
                behind: 0,
                dirty_count: 0,
                has_conflict: false,
            },
            last_synced_at: Some(OffsetDateTime::from_unix_timestamp(0).unwrap()),
        };

        let value = serde_json::to_value(summary).unwrap();

        assert_eq!(value["lastSyncedAt"], "1970-01-01T00:00:00Z");
    }

    #[test]
    fn legacy_working_files_default_to_tracked_for_safe_ignore_behavior() {
        let file: WorkingFile = serde_json::from_str(
            r#"{"path":"README.md","changeType":"modified","conflicted":false}"#,
        )
        .unwrap();

        assert!(file.tracked);
    }

    #[test]
    fn diff_windows_slice_lines_across_hunks_without_losing_totals() {
        let line = |content: &str| DiffLine {
            kind: DiffLineKind::Context,
            old_lineno: None,
            new_lineno: None,
            content: content.to_string(),
            line_ending: Some(DiffLineEnding::Lf),
        };
        let detail = FileDiffDetail {
            path: "large.txt".to_string(),
            change_type: FileChangeType::Modified,
            old_mode: Some(0o100644),
            new_mode: Some(0o100644),
            is_binary: false,
            hunks: vec![
                DiffHunk {
                    old_start: 1,
                    old_lines: 3,
                    new_start: 1,
                    new_lines: 3,
                    lines: vec![line("a"), line("b"), line("c")],
                },
                DiffHunk {
                    old_start: 10,
                    old_lines: 2,
                    new_start: 10,
                    new_lines: 2,
                    lines: vec![line("d"), line("e")],
                },
            ],
        };

        let window = detail.into_window(2, 2);

        assert_eq!(window.total_hunks, 2);
        assert_eq!(window.total_lines, 5);
        assert_eq!(window.hunks.len(), 2);
        assert_eq!(window.hunks[0].lines[0].content, "c");
        assert_eq!(window.hunks[1].lines[0].content, "d");
        assert_eq!(window.offset, 2);
        assert!(window.truncated);
        assert_eq!(window.next_offset, Some(4));
    }
}
