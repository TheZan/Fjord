//! The `GitBackend` port. See docs/specs/git-backend.md — this trait is
//! effectively half of the frontend/backend IPC contract, and the only
//! thing `fjord-services` is allowed to know about "how do we talk to Git".

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use fjord_domain::{
    BranchInfo, CommitPage, CommitSummary, FileDiff, FileDiffDetail, FileDiffWindow, GenerationSet,
    LogCursor, PatchSelection, RepoStatus, StashEntry, TagInfo, WorkingChanges,
};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPath(pub PathBuf);

impl RepoPath {
    pub fn new(path: PathBuf) -> Self {
        Self(path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProgress {
    pub completed: u32,
    pub total: u32,
    pub message: Option<String>,
}

/// Operation-local askpass configuration. It is intentionally opaque and
/// has no `Debug` implementation because it contains a bearer token.
#[derive(Clone)]
pub struct GitAskpassConfig {
    executable: Arc<PathBuf>,
    address: Arc<str>,
    token: Arc<str>,
    operation_id: Arc<str>,
}

impl GitAskpassConfig {
    pub fn new(executable: PathBuf, address: String, token: String, operation_id: String) -> Self {
        Self {
            executable: Arc::new(executable),
            address: Arc::from(address),
            token: Arc::from(token),
            operation_id: Arc::from(operation_id),
        }
    }

    pub fn executable(&self) -> &std::path::Path {
        self.executable.as_path()
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
}

#[derive(Clone, Default)]
pub struct GitOperationContext {
    progress: Option<Arc<dyn Fn(GitProgress) + Send + Sync>>,
    cancelled: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    git_executable_path: Option<Arc<PathBuf>>,
    askpass: Option<GitAskpassConfig>,
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
            askpass: None,
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

    pub fn with_askpass(mut self, askpass: Option<GitAskpassConfig>) -> Self {
        self.askpass = askpass;
        self
    }

    pub fn askpass(&self) -> Option<&GitAskpassConfig> {
        self.askpass.as_ref()
    }
}

/// Where the current branch pushes: resolved from its upstream configuration,
/// never assumed to be `origin` and never left to `push.default`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTarget {
    pub remote: String,
    /// Fully-qualified local ref, e.g. `refs/heads/main`.
    pub local_ref: String,
    /// Fully-qualified ref on the remote, e.g. `refs/heads/trunk`.
    pub remote_ref: String,
}

impl PushTarget {
    /// The explicit refspec passed to system Git.
    pub fn refspec(&self) -> String {
        format!("{}:{}", self.local_ref, self.remote_ref)
    }
}

/// The outcome of resolving which `git` binary Fjord may run.
///
/// There is deliberately no "fall back to whatever is on `PATH`" variant. A
/// configured executable that fails validation must not quietly become a
/// different Git for half the application — see docs/tasks.md P5-20 and
/// docs/specs/system-git-transport.md §"Executable discovery".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitExecutableResolution {
    /// A path that was validated by executing it.
    Resolved(PathBuf),
    /// No valid executable. Subprocess-backed operations must fail rather than
    /// run a Git the user did not choose.
    Unavailable,
}

#[derive(Debug, Clone, Error)]
pub enum GitError {
    #[error("repository not found at {0}")]
    RepoNotFound(PathBuf),
    #[error("no valid Git executable is available")]
    ExecutableNotFound,
    #[error("path is not a git repository: {0}")]
    NotAGitRepository(PathBuf),
    #[error("repository ownership refused: {0}")]
    RepositoryOwnership(String),
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
    #[error("the selected patch no longer matches the current diff")]
    PatchStale,
    #[error("the destructive preflight no longer matches the repository state")]
    PreflightStale,
    #[error("Git could not apply the selected patch: {0}")]
    PatchApplyFailed(String),
    #[error("the selected change cannot be represented as a line patch: {0}")]
    PatchUnsupported(String),
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
    fn generations(&self, _repo: &RepoPath) -> Result<GenerationSet, GitError> {
        Ok(GenerationSet::default())
    }

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
    /// Counts commits reachable from `tip` but not from the current `HEAD`,
    /// returning at most `sample_limit` summaries. Used by destructive
    /// preflight; transport remains outside this local backend.
    async fn commits_unreachable_from_head(
        &self,
        _repo: &RepoPath,
        _tip: &str,
        _sample_limit: u32,
    ) -> Result<(u32, Vec<CommitSummary>), GitError> {
        Err(GitError::NotImplemented("commits_unreachable_from_head"))
    }
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
    async fn file_diff_window(
        &self,
        repo: &RepoPath,
        commit_id: &str,
        path: &str,
        offset: u32,
        limit: u32,
        _max_file_bytes: u64,
    ) -> Result<FileDiffWindow, GitError> {
        Ok(self
            .file_diff(repo, commit_id, path)
            .await?
            .into_window(offset, limit))
    }

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
    async fn working_file_diff_window(
        &self,
        repo: &RepoPath,
        path: &str,
        staged: bool,
        offset: u32,
        limit: u32,
        _max_file_bytes: u64,
    ) -> Result<FileDiffWindow, GitError> {
        Ok(self
            .working_file_diff(repo, path, staged)
            .await?
            .into_window(offset, limit))
    }

    async fn checkout(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError>;
    /// Returns `(remote, refspec)` when checkout needs a remote branch to be
    /// materialized first. No network I/O is performed.
    async fn remote_checkout_refspec(
        &self,
        _repo: &RepoPath,
        _branch: &str,
    ) -> Result<Option<(String, String)>, GitError> {
        Ok(None)
    }
    /// Performs checkout after any required remote ref was fetched.
    async fn checkout_local(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError> {
        self.checkout(repo, branch).await
    }
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
    /// Stages a verified line selection against the exact repository
    /// generation from which it was rendered.
    async fn stage_patch(
        &self,
        _repo: &RepoPath,
        _selection: &PatchSelection,
        _expected_generations: GenerationSet,
    ) -> Result<GenerationSet, GitError> {
        Err(GitError::NotImplemented("stage_patch"))
    }
    async fn unstage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError>;
    /// Removes a verified index selection against the exact repository
    /// generation from which it was rendered.
    async fn unstage_patch(
        &self,
        _repo: &RepoPath,
        _selection: &PatchSelection,
        _expected_generations: GenerationSet,
    ) -> Result<GenerationSet, GitError> {
        Err(GitError::NotImplemented("unstage_patch"))
    }
    /// Discards a verified index-to-worktree selection against the exact
    /// generation confirmed by the destructive preflight.
    async fn discard_patch(
        &self,
        _repo: &RepoPath,
        _selection: &PatchSelection,
        _expected_generations: GenerationSet,
    ) -> Result<GenerationSet, GitError> {
        Err(GitError::NotImplemented("discard_patch"))
    }
    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<String, GitError>;
    /// Returns the configured remote for the current branch's upstream.
    async fn upstream_remote(&self, _repo: &RepoPath) -> Result<String, GitError> {
        Err(GitError::NotImplemented("upstream_remote"))
    }
    /// Resolves where the current branch pushes, from its configured upstream.
    /// Returns [`GitError::NoUpstream`] when the branch has none, so callers
    /// publish deliberately instead of inheriting `push.default`.
    async fn current_push_target(&self, _repo: &RepoPath) -> Result<PushTarget, GitError> {
        Err(GitError::NotImplemented("current_push_target"))
    }
    /// Returns the current branch's ref name, used when publishing a branch
    /// that has no upstream yet.
    async fn current_branch_ref(&self, _repo: &RepoPath) -> Result<String, GitError> {
        Err(GitError::NotImplemented("current_branch_ref"))
    }
    /// Integrates the already-fetched upstream using Fjord's fixed
    /// fast-forward/merge semantics. This method never performs network I/O.
    async fn integrate_upstream(&self, _repo: &RepoPath) -> Result<(), GitError> {
        Err(GitError::NotImplemented("integrate_upstream"))
    }
    async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError>;
    /// Points the backend's own Git subprocess calls at a resolved executable,
    /// so a path chosen in Settings applies to local operations too and not
    /// only to remote transport. [`GitExecutableResolution::Unavailable`] makes
    /// those calls fail with [`GitError::ExecutableNotFound`], the same
    /// condition remote transport reports, instead of silently running a
    /// different Git.
    fn set_git_executable(&self, _resolution: GitExecutableResolution) {}
}
