//! The `GitBackend` port. See docs/specs/git-backend.md — this trait is
//! effectively half of the frontend/backend IPC contract, and the only
//! thing `fjord-services` is allowed to know about "how do we talk to Git".

use std::path::PathBuf;

use async_trait::async_trait;
use fjord_domain::{
    BranchInfo, CommitPage, FileDiff, FileDiffDetail, LogCursor, RepoStatus, StashEntry, TagInfo,
    WorkingChanges,
};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPath(pub PathBuf);

impl RepoPath {
    pub fn new(path: PathBuf) -> Self {
        Self(path)
    }
}

#[derive(Debug, Error)]
pub enum GitError {
    #[error("repository not found at {0}")]
    RepoNotFound(PathBuf),
    #[error("path is not a git repository: {0}")]
    NotAGitRepository(PathBuf),
    #[error("merge conflict in {paths:?}")]
    Conflict { paths: Vec<String> },
    #[error("authentication failed")]
    AuthenticationFailed,
    #[error("current branch has no upstream")]
    NoUpstream,
    #[error("nothing to commit")]
    NothingToCommit,
    #[error("no merge conflicts detected")]
    NoConflicts,
    #[error("branch already exists: {0}")]
    BranchExists(String),
    #[error("nothing to stash")]
    NothingToStash,
    #[error("stash is empty")]
    StashEmpty,
    #[error("failed to launch merge tool: {0}")]
    MergeToolFailed(String),
    #[error("operation not yet implemented on this backend: {0}")]
    NotImplemented(&'static str),
    #[error("gix error: {0}")]
    Gix(String),
    #[error("git2 error: {0}")]
    Git2(String),
}

/// Everything the app needs from Git, expressed in domain terms.
///
/// Implemented once, in `fjord-git`, routing each method to `gix` or `git2`
/// per the table in docs/specs/git-backend.md. Callers here never know or
/// care which engine served a given call.
#[async_trait]
pub trait GitBackend: Send + Sync {
    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError>;
    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError>;
    async fn tags(&self, repo: &RepoPath) -> Result<Vec<TagInfo>, GitError>;
    async fn log(
        &self,
        repo: &RepoPath,
        from: Option<LogCursor>,
        limit: u32,
    ) -> Result<CommitPage, GitError>;
    async fn diff(&self, repo: &RepoPath, commit_id: &str) -> Result<Vec<FileDiff>, GitError>;
    async fn file_diff(
        &self,
        repo: &RepoPath,
        commit_id: &str,
        path: &str,
    ) -> Result<FileDiffDetail, GitError>;

    /// Uncommitted work, split into staged and unstaged — what the commit
    /// panel lists and what `commit` would actually record.
    async fn working_changes(&self, repo: &RepoPath) -> Result<WorkingChanges, GitError>;
    /// Line-level diff of an uncommitted file: index-vs-HEAD when `staged`,
    /// worktree-vs-index otherwise.
    async fn working_file_diff(
        &self,
        repo: &RepoPath,
        path: &str,
        staged: bool,
    ) -> Result<FileDiffDetail, GitError>;

    async fn checkout(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError>;
    /// Creates `name` at the current HEAD, optionally switching to it.
    async fn create_branch(
        &self,
        repo: &RepoPath,
        name: &str,
        checkout: bool,
    ) -> Result<(), GitError>;
    async fn stashes(&self, repo: &RepoPath) -> Result<Vec<StashEntry>, GitError>;
    async fn stash_push(&self, repo: &RepoPath, message: Option<&str>) -> Result<(), GitError>;
    /// Applies and drops `stash@{0}`, the most recent entry.
    async fn stash_pop(&self, repo: &RepoPath) -> Result<(), GitError>;
    async fn stage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError>;
    async fn unstage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError>;
    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<String, GitError>;
    async fn fetch(&self, repo: &RepoPath, remote: &str) -> Result<(), GitError>;
    async fn pull(&self, repo: &RepoPath) -> Result<(), GitError>;
    async fn push(&self, repo: &RepoPath, refspec: &str) -> Result<(), GitError>;
    async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError>;
}
