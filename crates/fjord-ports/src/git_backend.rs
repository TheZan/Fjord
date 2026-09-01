//! The `GitBackend` port. See docs/specs/git-backend.md — this trait is
//! effectively half of the frontend/backend IPC contract, and the only
//! thing `fjord-services` is allowed to know about "how do we talk to Git".

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use fjord_domain::{
    AmendInfo, BranchInfo, CommitPage, CommitSummary, Consequence, CreateBranchFromStashResult,
    CreateStashRequest, CreateStashResult, DestructiveAction, DestructiveExecutionResult,
    DiffWhitespaceMode, FileDiff, FileDiffDetail, FileDiffWindow, GenerationSet, IgnoreRuleKind,
    IgnoreRuleOutcome, IgnoreRulePreview, LogCursor, MergeDirtyPolicy, MergeMode, MergePreflight,
    MergeResult, MergeSource, PatchSelection, PatchSource, Recoverability, ReflogPage, RemoteInfo,
    RemoveRemotePreflight, RepoOperationState, RepoStatus, SquashMergeResult, StashApplyResult,
    StashEntry, StashFileGroup, StashFiles, StashId, TagInfo, WorkingChanges,
};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPath(pub PathBuf);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffWindowOptions {
    pub offset: u32,
    pub limit: u32,
    pub max_file_bytes: u64,
    pub whitespace: DiffWhitespaceMode,
}

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

/// Exact source and lease facts captured for one force-push confirmation.
/// The source is an immutable object id so a moving local branch cannot widen
/// the operation after confirmation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForcePushPlan {
    pub remote: String,
    pub remote_ref: String,
    pub expected_oid: String,
    pub source_oid: String,
}

/// Backend-computed facts for destructive actions that do not require remote
/// transport or patch-coordinate validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestructiveActionFacts {
    pub consequences: Vec<Consequence>,
    pub recoverable: Recoverability,
    pub blockers: Vec<String>,
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
    #[error("invalid repository initialization request: {0}")]
    InvalidRepositoryInitialization(String),
    #[error("repository destination is invalid: {0}")]
    RepositoryDestinationInvalid(String),
    #[error("repository destination is not empty")]
    RepositoryDestinationNotEmpty,
    #[error("remote already exists: {0}")]
    RemoteAlreadyExists(String),
    #[error("remote not found: {0}")]
    RemoteNotFound(String),
    #[error("invalid remote name")]
    InvalidRemoteName,
    #[error("invalid remote URL")]
    InvalidRemoteUrl,
    #[error("remote rename target already exists: {0}")]
    RemoteRenameTargetExists(String),
    #[error("invalid remote configuration: {0}")]
    InvalidRemote(String),
    #[error("nothing to stash")]
    NothingToStash,
    #[error("the selected stash no longer exists")]
    StashNotFound,
    #[error("more than one stash entry points at the selected stash commit")]
    StashAmbiguous,
    #[error("stash apply would overwrite local changes in {paths:?}")]
    StashApplyWouldOverwrite { paths: Vec<String> },
    #[error("Git refused to restore the stash's staged state")]
    StashApplyIndexRefused,
    #[error("stash apply failed: {0}")]
    StashApplyFailed(String),
    #[error("checkout would overwrite local changes in {paths:?}")]
    CheckoutWouldOverwrite { paths: Vec<String> },
    #[error("merge source was not found")]
    MergeSourceNotFound,
    #[error("the merge source is the current branch")]
    MergeSourceIsCurrentBranch,
    #[error("the merge source kind is not supported")]
    MergeSourceUnsupported,
    #[error("the merge cannot be completed as a fast-forward")]
    MergeNotFastForward,
    #[error("merge would overwrite local changes in {paths:?}")]
    MergeWouldOverwrite { paths: Vec<String> },
    #[error("the index contains staged changes")]
    MergeIndexHasStagedChanges,
    #[error("HEAD is detached")]
    MergeDetachedHead,
    #[error("HEAD is unborn")]
    MergeUnbornHead,
    #[error("another repository operation is already in progress")]
    OperationAlreadyInProgress,
    #[error("merge failed: {0}")]
    MergeFailed(String),
    #[error("{0}")]
    MergeStashRetained(Box<GitError>),
    #[error("failed to launch merge tool: {0}")]
    MergeToolFailed(String),
    #[error("operation cancelled")]
    Cancelled,
    #[error("no repository operation is in progress")]
    OperationNotInProgress,
    #[error("repository operation still has unresolved conflicts in {paths:?}")]
    OperationHasConflicts { paths: Vec<String> },
    #[error("repository operation step failed: {0}")]
    OperationStepFailed(String),
    #[error("the selected patch no longer matches the current diff")]
    PatchStale,
    #[error("the destructive preflight no longer matches the repository state")]
    PreflightStale,
    #[error("Git could not apply the selected patch: {0}")]
    PatchApplyFailed(String),
    #[error("the selected change cannot be represented as a line patch: {0}")]
    PatchUnsupported(String),
    #[error("ignore rules are unavailable for tracked file: {0}")]
    IgnoreRuleUnsupportedForTrackedFile(String),
    #[error(".gitignore is not valid UTF-8")]
    IgnoreFileEncodingUnsupported,
    #[error("failed to update .gitignore: {0}")]
    IgnoreWriteFailed(String),
    #[error("only files can be deleted from this menu")]
    DeleteTargetNotAFile,
    #[error("{path} also has staged changes")]
    DeleteFilePartiallyStaged { path: String },
    #[error("{path} has unresolved conflicts")]
    DeleteFileConflicted { path: String },
    #[error("Git could not resolve the difftool {tool}")]
    DiffToolNotConfigured { tool: String },
    #[error("the diff tool name is invalid")]
    DiffToolNameInvalid,
    #[error("exact path-scoped stash creation requires Git 2.23 or newer")]
    StashFileUnsupportedGit,
    #[error("{path} has unresolved conflicts")]
    StashFileConflicted { path: String },
    #[error("the scoped stash path set is empty")]
    StashScopeEmpty,
    #[error("the repository changed while the exact stash was being created")]
    StashConcurrentUpdate,
    #[error("stash creation failed and repository state could not be fully restored")]
    StashRecoveryFailed,
    #[error("the selected state cannot be represented exactly: {path}")]
    StashScopeUnrepresentable { path: String },
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

    /// Initializes one non-bare local repository with an unborn branch.
    /// Implementations must reject non-empty destinations and must not publish
    /// a partially initialized target when initialization fails.
    async fn init_repository(
        &self,
        _repo: &RepoPath,
        _initial_branch: &str,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("init_repository"))
    }

    async fn remotes(&self, _repo: &RepoPath) -> Result<Vec<RemoteInfo>, GitError> {
        Err(GitError::NotImplemented("remotes"))
    }

    async fn add_remote(
        &self,
        _repo: &RepoPath,
        _name: &str,
        _url: &str,
    ) -> Result<RemoteInfo, GitError> {
        Err(GitError::NotImplemented("add_remote"))
    }

    async fn set_remote_url(
        &self,
        _repo: &RepoPath,
        _name: &str,
        _fetch: &str,
        _push: Option<&str>,
    ) -> Result<RemoteInfo, GitError> {
        Err(GitError::NotImplemented("set_remote_url"))
    }

    async fn rename_remote(
        &self,
        _repo: &RepoPath,
        _old: &str,
        _new: &str,
    ) -> Result<RemoteInfo, GitError> {
        Err(GitError::NotImplemented("rename_remote"))
    }

    async fn preflight_remove_remote(
        &self,
        _repo: &RepoPath,
        _name: &str,
    ) -> Result<RemoveRemotePreflight, GitError> {
        Err(GitError::NotImplemented("preflight_remove_remote"))
    }

    /// Deletes one remote only after consuming the exact backend-issued
    /// preflight binding under the repository write lock.
    async fn remove_remote(
        &self,
        _repo: &RepoPath,
        _name: &str,
        _expected_config_generation: u64,
        _confirmation_token: &str,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("remove_remote"))
    }

    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError>;
    /// Reads the operation markers in the resolved per-worktree git-dir.
    /// Implementations must not infer this solely from cached status.
    async fn operation_state(&self, _repo: &RepoPath) -> Result<RepoOperationState, GitError> {
        Err(GitError::NotImplemented("operation_state"))
    }
    async fn continue_operation(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError> {
        self.continue_operation_with_context(repo, GitOperationContext::default())
            .await
    }
    async fn continue_operation_with_context(
        &self,
        _repo: &RepoPath,
        _context: GitOperationContext,
    ) -> Result<RepoOperationState, GitError> {
        Err(GitError::NotImplemented("continue_operation"))
    }
    async fn skip_operation(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError> {
        self.skip_operation_with_context(repo, GitOperationContext::default())
            .await
    }
    async fn skip_operation_with_context(
        &self,
        _repo: &RepoPath,
        _context: GitOperationContext,
    ) -> Result<RepoOperationState, GitError> {
        Err(GitError::NotImplemented("skip_operation"))
    }
    async fn abort_operation(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError> {
        self.abort_operation_with_context(repo, GitOperationContext::default())
            .await
    }
    async fn abort_operation_with_context(
        &self,
        _repo: &RepoPath,
        _context: GitOperationContext,
    ) -> Result<RepoOperationState, GitError> {
        Err(GitError::NotImplemented("abort_operation"))
    }
    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError>;
    async fn merge_preflight(
        &self,
        _repo: &RepoPath,
        _source: &MergeSource,
    ) -> Result<MergePreflight, GitError> {
        Err(GitError::NotImplemented("merge_preflight"))
    }
    async fn merge_branch(
        &self,
        _repo: &RepoPath,
        _source: &MergeSource,
        _mode: MergeMode,
        _dirty_policy: MergeDirtyPolicy,
        _context: GitOperationContext,
    ) -> Result<MergeResult, GitError> {
        Err(GitError::NotImplemented("merge_branch"))
    }
    /// `merge --squash`: stages the combined diff (or leaves it conflicted)
    /// without a merge commit or moving any ref. Shares `merge_preflight`'s
    /// blockers and dirty-tree rules.
    async fn squash_merge_branch(
        &self,
        _repo: &RepoPath,
        _source: &MergeSource,
        _dirty_policy: MergeDirtyPolicy,
        _context: GitOperationContext,
    ) -> Result<SquashMergeResult, GitError> {
        Err(GitError::NotImplemented("squash_merge_branch"))
    }
    async fn tags(&self, repo: &RepoPath) -> Result<Vec<TagInfo>, GitError>;
    async fn log(
        &self,
        repo: &RepoPath,
        from: Option<LogCursor>,
        limit: u32,
    ) -> Result<CommitPage, GitError>;
    async fn reflog(
        &self,
        _repo: &RepoPath,
        _ref_name: Option<&str>,
        _from: Option<LogCursor>,
        _limit: u32,
    ) -> Result<ReflogPage, GitError> {
        Err(GitError::NotImplemented("reflog"))
    }
    async fn reflog_refs(&self, _repo: &RepoPath) -> Result<Vec<String>, GitError> {
        Err(GitError::NotImplemented("reflog_refs"))
    }
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
    async fn destructive_action_facts(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _sample_limit: u32,
    ) -> Result<DestructiveActionFacts, GitError> {
        Err(GitError::NotImplemented("destructive_action_facts"))
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
    async fn diff_against_head(
        &self,
        _repo: &RepoPath,
        _commit_id: &str,
    ) -> Result<Vec<FileDiff>, GitError> {
        Err(GitError::NotImplemented("diff_against_head"))
    }
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
        options: DiffWindowOptions,
    ) -> Result<FileDiffWindow, GitError> {
        Ok(self
            .file_diff(repo, commit_id, path)
            .await?
            .into_window(options.offset, options.limit))
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
        options: DiffWindowOptions,
    ) -> Result<FileDiffWindow, GitError> {
        Ok(self
            .working_file_diff(repo, path, staged)
            .await?
            .into_window(options.offset, options.limit))
    }
    async fn preview_ignore_rule(
        &self,
        _repo: &RepoPath,
        _path: &str,
        _kind: IgnoreRuleKind,
    ) -> Result<IgnoreRulePreview, GitError> {
        Err(GitError::NotImplemented("preview_ignore_rule"))
    }
    async fn add_ignore_rule(
        &self,
        _repo: &RepoPath,
        _path: &str,
        _kind: IgnoreRuleKind,
    ) -> Result<IgnoreRuleOutcome, GitError> {
        Err(GitError::NotImplemented("add_ignore_rule"))
    }

    async fn checkout(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError>;
    /// Returns the bounded repository-relative dirty paths that checkout would
    /// overwrite. The mutation rechecks this under its write lock.
    async fn checkout_overwrite_paths(
        &self,
        _repo: &RepoPath,
        _branch: &str,
    ) -> Result<Vec<String>, GitError> {
        Err(GitError::NotImplemented("checkout_overwrite_paths"))
    }
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
    async fn stash_and_checkout(
        &self,
        _repo: &RepoPath,
        _branch: &str,
        _message: &str,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("stash_and_checkout"))
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
    /// Sets a local branch's upstream to an existing remote-tracking branch.
    async fn set_branch_upstream(
        &self,
        _repo: &RepoPath,
        _branch: &str,
        _upstream: &str,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("set_branch_upstream"))
    }
    async fn unset_branch_upstream(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
        Err(GitError::NotImplemented("unset_branch_upstream"))
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
    async fn stash_files(
        &self,
        _repo: &RepoPath,
        _stash_id: &StashId,
        _limit: u32,
    ) -> Result<StashFiles, GitError> {
        Err(GitError::NotImplemented("stash_files"))
    }
    async fn stash_file_diff_window(
        &self,
        _repo: &RepoPath,
        _stash_id: &StashId,
        _group: StashFileGroup,
        _path: &str,
        _options: DiffWindowOptions,
    ) -> Result<FileDiffWindow, GitError> {
        Err(GitError::NotImplemented("stash_file_diff_window"))
    }
    async fn create_stash(
        &self,
        _repo: &RepoPath,
        _request: &CreateStashRequest,
    ) -> Result<CreateStashResult, GitError> {
        Err(GitError::NotImplemented("create_stash"))
    }
    async fn apply_stash(
        &self,
        _repo: &RepoPath,
        _stash_id: &StashId,
        _restore_index: bool,
    ) -> Result<StashApplyResult, GitError> {
        Err(GitError::NotImplemented("apply_stash"))
    }
    async fn create_branch_from_stash(
        &self,
        _repo: &RepoPath,
        _stash_id: &StashId,
        _name: &str,
        _apply: bool,
        _keep: bool,
    ) -> Result<CreateBranchFromStashResult, GitError> {
        Err(GitError::NotImplemented("create_branch_from_stash"))
    }
    /// Whether the resolved Git executable supports exact scoped stash
    /// construction (currently Git >= 2.23).
    async fn stash_paths_supported(&self) -> Result<bool, GitError> {
        Err(GitError::NotImplemented("stash_paths_supported"))
    }
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
    /// Issues a short-lived backend confirmation for one exact ordered discard
    /// scope. A single-file discard is represented by a one-element slice.
    async fn issue_discard_confirmation(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _selections: &[PatchSelection],
        _generations: GenerationSet,
    ) -> Result<String, GitError> {
        Err(GitError::NotImplemented("issue_discard_confirmation"))
    }
    /// Issues a short-lived confirmation bound to an exact action and
    /// generation stamp. Action-specific execution consumes this in P9-06.
    async fn issue_action_confirmation(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _generations: GenerationSet,
    ) -> Result<String, GitError> {
        Err(GitError::NotImplemented("issue_action_confirmation"))
    }
    /// Consumes an action-only confirmation after checking the complete
    /// repository/action/generation binding. Used when execution belongs to a
    /// different adapter, such as remote transport.
    async fn consume_action_confirmation(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _expected_generations: GenerationSet,
        _confirmation_token: &str,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("consume_action_confirmation"))
    }
    /// Atomically consumes a confirmation and executes a local destructive
    /// action under the repository write lock.
    async fn execute_confirmed_destructive_action(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _expected_generations: GenerationSet,
        _confirmation_token: &str,
        _context: GitOperationContext,
    ) -> Result<DestructiveExecutionResult, GitError> {
        Err(GitError::NotImplemented(
            "execute_confirmed_destructive_action",
        ))
    }
    /// Discards a verified index-to-worktree selection only after atomically
    /// validating and consuming its backend-issued confirmation.
    async fn discard_patch(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _selection: &PatchSelection,
        _expected_generations: GenerationSet,
        _confirmation_token: &str,
    ) -> Result<GenerationSet, GitError> {
        Err(GitError::NotImplemented("discard_patch"))
    }
    /// Discards an exact ordered vector of whole-file worktree selections in
    /// one confirmation-bound Git apply transaction.
    async fn discard_patches(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _selections: &[PatchSelection],
        _expected_generations: GenerationSet,
        _confirmation_token: &str,
    ) -> Result<GenerationSet, GitError> {
        Err(GitError::NotImplemented("discard_patches"))
    }
    /// Read-only: constructs the patch bytes for an exact non-empty vector of
    /// source-homogeneous working-file selections (unstaged
    /// `INDEX -> WORKTREE` or staged `HEAD -> INDEX`) without
    /// mutating the repository. Reuses the same deterministic constructor
    /// and digest verification as the mutating patch commands.
    async fn export_patch(
        &self,
        _repo: &RepoPath,
        _selections: &[PatchSelection],
    ) -> Result<Vec<u8>, GitError> {
        Err(GitError::NotImplemented("export_patch"))
    }
    /// Returns the current commit message and whether the current branch's
    /// locally known upstream already contains `HEAD`.
    async fn amend_info(&self, _repo: &RepoPath) -> Result<AmendInfo, GitError> {
        Err(GitError::NotImplemented("amend_info"))
    }
    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<String, GitError>;
    async fn amend(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> {
        Err(GitError::NotImplemented("amend"))
    }
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
    /// Resolves the configured push target, remote-tracking oid, and exact
    /// local source commit from authoritative repository state.
    async fn force_push_plan(&self, _repo: &RepoPath) -> Result<ForcePushPlan, GitError> {
        Err(GitError::NotImplemented("force_push_plan"))
    }
    /// Issues a short-lived confirmation bound to the exact force-push plan.
    async fn issue_force_push_confirmation(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _plan: &ForcePushPlan,
        _generations: GenerationSet,
    ) -> Result<String, GitError> {
        Err(GitError::NotImplemented("issue_force_push_confirmation"))
    }
    /// Atomically consumes a force-push confirmation and returns only its
    /// backend-bound plan after revalidating current local state.
    async fn consume_force_push_confirmation(
        &self,
        _repo: &RepoPath,
        _action: &DestructiveAction,
        _expected_generations: GenerationSet,
        _confirmation_token: &str,
    ) -> Result<ForcePushPlan, GitError> {
        Err(GitError::NotImplemented("consume_force_push_confirmation"))
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
    /// Whether the given diff-tool preference (`None` = Auto, `Some(name)` =
    /// an explicit Git difftool name) currently resolves to something Git can
    /// run: `Auto` resolves when `diff.tool` is configured, and a named tool
    /// resolves when Git recognizes it (`git difftool --tool-help`), whether
    /// or not its underlying binary happens to be installed. Read-only.
    async fn diff_tool_availability(
        &self,
        _repo: &RepoPath,
        _preference: Option<&str>,
    ) -> Result<bool, GitError> {
        Err(GitError::NotImplemented("diff_tool_availability"))
    }
    /// Launches `git difftool` for one file and one diff side (`P10-WC-06`).
    /// `source == Worktree` diffs `INDEX -> WORKTREE`; `source == Index` adds
    /// `--cached` to diff `HEAD -> INDEX`, matching the row the user
    /// right-clicked. Fails with [`GitError::DiffToolNotConfigured`] rather
    /// than falling back to Git's interactive tool chooser.
    async fn open_external_diff(
        &self,
        _repo: &RepoPath,
        _path: &str,
        _source: PatchSource,
        _preference: Option<&str>,
    ) -> Result<(), GitError> {
        Err(GitError::NotImplemented("open_external_diff"))
    }
    /// Points the backend's own Git subprocess calls at a resolved executable,
    /// so a path chosen in Settings applies to local operations too and not
    /// only to remote transport. [`GitExecutableResolution::Unavailable`] makes
    /// those calls fail with [`GitError::ExecutableNotFound`], the same
    /// condition remote transport reports, instead of silently running a
    /// different Git.
    fn set_git_executable(&self, _resolution: GitExecutableResolution) {}
}
