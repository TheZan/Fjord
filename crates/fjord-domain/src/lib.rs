//! Core entities and value objects shared across Fjord.
//!
//! This crate has no knowledge of Tauri, SQLite, or any Git engine — see
//! `docs/SDD.md` §5.1. It exists so `fjord-services` has something to
//! operate on without depending on infrastructure.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkspaceId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryEntry {
    pub id: RepositoryId,
    pub workspace_id: WorkspaceId,
    pub name: String,
    /// Absolute path, platform-native separators. Comparison/dedup goes
    /// through `fjord-fs`'s normalization helper, never a raw string compare
    /// — see docs/specs/data-model.md.
    pub path: PathBuf,
    pub sort_order: i32,
}

/// Live status for a single repository, as returned by `GitBackend::status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty_count: u32,
    pub has_conflict: bool,
}

/// The cached counterpart of `RepoStatus` — always safe to drop and rebuild
/// from a live `RepoStatus` call. See docs/specs/data-model.md.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatusSummary {
    pub repo_id: RepositoryId,
    pub status: RepoStatus,
    pub last_synced_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub id: CommitId,
    pub parent_ids: Vec<CommitId>,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: OffsetDateTime,
    pub refs: Vec<String>,
}

/// Opaque pagination cursor for `GitBackend::log`. Callers must not parse
/// or construct one themselves — round-trip whatever `CommitPage.next_cursor`
/// returned. See docs/specs/git-backend.md and docs/specs/ipc-commands.md.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogCursor(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPage {
    pub commits: Vec<CommitSummary>,
    pub next_cursor: Option<LogCursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub change_type: FileChangeType,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

impl Default for Theme {
    fn default() -> Self {
        Theme::System
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// BCP-47-ish locale code, e.g. "en", "ru". See docs/specs/i18n.md.
    pub locale: String,
    pub theme: Theme,
    pub default_ide: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            locale: "en".to_string(),
            theme: Theme::System,
            default_ide: None,
        }
    }
}
