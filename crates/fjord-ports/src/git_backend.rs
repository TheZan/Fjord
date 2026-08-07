//! The `GitBackend` port. See docs/specs/git-backend.md — this trait is
//! effectively half of the frontend/backend IPC contract, and the only
//! thing `fjord-services` is allowed to know about "how do we talk to Git".

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use fjord_domain::{
    BranchInfo, CommitPage, CommitSummary, FileDiff, FileDiffDetail, LogCursor, RepoStatus,
    StashEntry, TagInfo, WorkingChanges,
};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPath(pub PathBuf);

impl RepoPath {
    pub fn new(path: PathBuf) -> Self {
        Self(path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitProgress {
    pub completed: u32,
    pub total: u32,
}

#[derive(Clone, Default)]
pub struct GitOperationContext {
    progress: Option<Arc<dyn Fn(GitProgress) + Send + Sync>>,
    cancelled: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    git_executable_path: Option<Arc<PathBuf>>,
}

impl GitOperationContext {
    pub fn new(
        progress: impl Fn(GitProgress) + Send + Sync + 'static,
        cancelled: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            progress: Some(Arc::new(progress)),
            cancelled: Some(Arc::new(cancelled)),
            git_executable_path: None,
        }
    }

    pub fn emit(&self, progress: GitProgress) {
        if let Some(callback) = &self.progress {
            callback(progress);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.as_ref().is_some_and(|cancelled| cancelled())
    }

    pub fn with_git_executable_path(mut self, path: Option<PathBuf>) -> Self {
        self.git_executable_path = path.map(Arc::new);
        self
    }

    pub fn git_executable_path(&self) -> Option<&std::path::Path> {
        self.git_executable_path.as_deref().map(PathBuf::as_path)
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
    #[error("operation cancelled")]
    Cancelled,
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
    async fn search_commits(
        &self,
        repo: &RepoPath,
        query: &str,
        limit: u32,
    ) -> Result<Vec<CommitSummary>, GitError>;
    /// Fast tree-only file list used to paint commit inspectors before line
    /// statistics finish. Backends may fall back to the full diff.
    async fn diff_files(
        &self,
        repo: &RepoPath,
        commit_id: &str,
    ) -> Result<Vec<FileDiff>, GitError> {
        self.diff(repo, commit_id).await
    }
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
    async fn create_branch_at(
        &self,
        _repo: &RepoPath,
        _name: &str,
        _target: &str,
        _checkout: bool,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("create_branch_at"))
    }
    async fn rename_branch(
        &self,
        _repo: &RepoPath,
        _old_name: &str,
        _new_name: &str,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("rename_branch"))
    }
    async fn delete_branch(&self, _repo: &RepoPath, _name: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("delete_branch"))
    }
    async fn delete_remote_branch(&self, _repo: &RepoPath, _name: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("delete_remote_branch"))
    }
    async fn create_tag(
        &self,
        _repo: &RepoPath,
        _name: &str,
        _target: &str,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("create_tag"))
    }
    async fn delete_tag(&self, _repo: &RepoPath, _name: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("delete_tag"))
    }
    async fn cherry_pick(&self, _repo: &RepoPath, _commit_id: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("cherry_pick"))
    }
    async fn revert(&self, _repo: &RepoPath, _commit_id: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("revert"))
    }
    async fn reset(&self, _repo: &RepoPath, _commit_id: &str, _mode: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("reset"))
    }
    async fn stashes(&self, repo: &RepoPath) -> Result<Vec<StashEntry>, GitError>;
    async fn stash_push(&self, repo: &RepoPath, message: Option<&str>) -> Result<(), GitError>;
    /// Applies and drops `stash@{0}`, the most recent entry.
    async fn stash_pop(&self, repo: &RepoPath) -> Result<(), GitError>;
    async fn stage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError>;
    async fn unstage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError>;
    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<String, GitError>;
    /// Returns the configured remote for the current branch's upstream.
    async fn upstream_remote(&self, _repo: &RepoPath) -> Result<String, GitError> {
        Err(GitError::NotImplemented("upstream_remote"))
    }
    /// Returns an explicit current-branch refspec for system-Git push.
    async fn current_branch_refspec(&self, _repo: &RepoPath) -> Result<String, GitError> {
        Err(GitError::NotImplemented("current_branch_refspec"))
    }
    /// Integrates the already-fetched upstream using Fjord's fixed
    /// fast-forward/merge semantics. This method never performs network I/O.
    async fn integrate_upstream(&self, _repo: &RepoPath) -> Result<(), GitError> {
        Err(GitError::NotImplemented("integrate_upstream"))
    }
    // Legacy migration surface. Production remote call sites use
    // `GitRemoteBackend`; these methods remain until P5-19 cleanup.
    async fn fetch(&self, repo: &RepoPath, remote: &str) -> Result<(), GitError>;
    async fn pull(&self, repo: &RepoPath) -> Result<(), GitError>;
    async fn push(&self, repo: &RepoPath, refspec: &str) -> Result<(), GitError>;
    async fn fetch_with_context(
        &self,
        repo: &RepoPath,
        remote: &str,
        _context: GitOperationContext,
    ) -> Result<(), GitError> {
        self.fetch(repo, remote).await
    }
    async fn pull_with_context(
        &self,
        repo: &RepoPath,
        _context: GitOperationContext,
    ) -> Result<(), GitError> {
        self.pull(repo).await
    }
    async fn push_with_context(
        &self,
        repo: &RepoPath,
        refspec: &str,
        _context: GitOperationContext,
    ) -> Result<(), GitError> {
        self.push(repo, refspec).await
    }
    async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError>;
}
