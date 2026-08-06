//! Core entities and value objects shared across Fjord.
//!
//! This crate has no knowledge of Tauri, SQLite, or any Git engine — see
//! `docs/SDD.md` §5.1. It exists so `fjord-services` has something to
//! operate on without depending on infrastructure.

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
    pub target_commit_id: CommitId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub target_commit_id: CommitId,
}

/// One entry of the stash stack. `index` is the `stash@{n}` position — 0 is
/// the most recent, which is what a plain "pop" applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
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

/// Opaque pagination cursor for `GitBackend::log`. Callers must not parse
/// or construct one themselves — round-trip whatever `CommitPage.next_cursor`
/// returned. See docs/specs/git-backend.md and docs/specs/ipc-commands.md.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LogCursor(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CommitPage {
    pub commits: Vec<CommitSummary>,
    pub next_cursor: Option<LogCursor>,
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
    /// `true` when the entry is an unresolved merge conflict.
    pub conflicted: bool,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
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
    /// `true` if either side of the diff was detected as binary — `hunks` is empty in that case.
    pub is_binary: bool,
    pub hunks: Vec<DiffHunk>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct Settings {
    /// BCP-47-ish locale code, e.g. "en", "ru". See docs/specs/i18n.md.
    pub locale: String,
    pub theme: Theme,
    pub default_ide: Option<String>,
    pub auto_fetch: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            locale: "en".to_string(),
            theme: Theme::System,
            default_ide: None,
            auto_fetch: false,
        }
    }
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
}
