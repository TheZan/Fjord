use std::sync::Arc;

use fjord_domain::{
    BranchInfo, BulkRepoResult, CommitPage, CommitSummary, Consequence, DestructiveAction,
    DestructivePreflight, DiffHunk, DiffLineKind, DiffWhitespaceMode, DiscardSelection,
    FileChangeType, FileDiff, FileDiffDetail, FileDiffWindow, ForceWithLeaseDetails, GenerationSet,
    GitConnectionTestResult, GitEnvironmentInfo, GlobalSearchResult, LogCursor, PatchSelection,
    Recoverability, ReflogPage, RepoOperationState, RepoStatus, RepositoryEntry, RepositoryId,
    RepositorySnapshot, SearchResultKind, SnapshotRevalidation, StashEntry,
    StoredRepositorySnapshot, TagInfo, WorkingChanges, WorkspaceId,
};
use fjord_ports::{
    DiffWindowOptions, GitBackend, GitEnvironmentError, GitEnvironmentProvider, GitError,
    GitExecutableResolution, GitOperationContext, GitRemoteBackend, GitRemoteError, IdeLauncher,
    LaunchError, RepoPath, SettingsStore, StoreError, WorkspaceStore,
};
use std::path::PathBuf;
use thiserror::Error;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

const BULK_WORKER_LIMIT: usize = 6;
const SEARCH_COMMIT_SCAN_LIMIT: u32 = 80;
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 2;
const SNAPSHOT_CAPTURE_ATTEMPTS: usize = 3;
const PREFLIGHT_CAPTURE_ATTEMPTS: usize = 3;
const PATCH_DIFF_CAPTURE_ATTEMPTS: usize = 3;
const PREFLIGHT_SAMPLE_LIMIT: usize = 5;
pub const DIFF_WINDOW_DEFAULT_LINES: u32 = 1_000;
pub const DIFF_WINDOW_MAX_LINES: u32 = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffRequestOptions {
    pub offset: u32,
    pub limit: u32,
    pub whitespace: DiffWhitespaceMode,
    pub load_anyway: bool,
}
pub const DIFF_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const DIFF_FILE_MAX_BYTES: u64 = 10 * 1024 * 1024;
const DIFF_RESPONSE_ENVELOPE_RESERVE_BYTES: usize = 4 * 1024;

#[derive(Debug, Error)]
pub enum RepoError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Remote(#[from] GitRemoteError),
    #[error(transparent)]
    Environment(#[from] GitEnvironmentError),
    #[error(transparent)]
    Launch(#[from] LaunchError),
    #[error("repository changed while its snapshot was being captured")]
    SnapshotChangedDuringCapture,
    #[error("repository changed while destructive consequences were being computed")]
    PreflightChangedDuringCapture,
    #[error("serialized diff window is {actual_bytes} bytes; maximum is {max_bytes} bytes")]
    DiffWindowTooLarge {
        actual_bytes: usize,
        max_bytes: usize,
    },
}

#[derive(Debug)]
pub struct CommitPushOutcome {
    pub commit_id: String,
    pub push_error: Option<RepoError>,
}

/// The remote a branch is published to when the caller does not name one.
/// Only ever used for the explicit publish action, never for a plain push.
const DEFAULT_PUBLISH_REMOTE: &str = "origin";

/// What the local backend should run, given an inspection result. An invalid
/// configured path yields `Unavailable`, matching what remote transport does
/// with the same setting.
fn resolution_of(info: &GitEnvironmentInfo) -> GitExecutableResolution {
    match (&info.executable_path, info.configured_path_valid) {
        (Some(path), true) => GitExecutableResolution::Resolved(path.clone()),
        _ => GitExecutableResolution::Unavailable,
    }
}

fn normalized_diff_limit(limit: u32) -> u32 {
    if limit == 0 {
        DIFF_WINDOW_DEFAULT_LINES
    } else {
        limit.min(DIFF_WINDOW_MAX_LINES)
    }
}

fn ensure_diff_response_ceiling(window: FileDiffWindow) -> Result<FileDiffWindow, RepoError> {
    let actual_bytes = serde_json::to_vec(&window)
        .map_err(|error| GitError::Gix(error.to_string()))?
        .len();
    // Commands wrap this value in a small GenerationEnvelope. Keep room for
    // that wrapper so the complete IPC response, not merely its data field,
    // stays under the advertised ceiling.
    if actual_bytes > DIFF_RESPONSE_MAX_BYTES - DIFF_RESPONSE_ENVELOPE_RESERVE_BYTES {
        return Err(RepoError::DiffWindowTooLarge {
            actual_bytes,
            max_bytes: DIFF_RESPONSE_MAX_BYTES,
        });
    }
    Ok(window)
}

fn discard_consequences(
    selection: &DiscardSelection,
    diff: &FileDiffDetail,
) -> (Vec<Consequence>, Recoverability, Vec<String>) {
    if diff.is_binary {
        return (
            Vec::new(),
            Recoverability::NotRecoverable,
            vec!["binary_changes_unsupported".to_string()],
        );
    }

    let selected_count = match selection {
        DiscardSelection::File { .. } => diff.hunks.iter().map(changed_line_count).sum(),
        DiscardSelection::Hunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            ..
        } => match matching_hunk(diff, *old_start, *old_lines, *new_start, *new_lines) {
            Some(hunk) => changed_line_count(hunk),
            None => {
                return (
                    Vec::new(),
                    Recoverability::NotRecoverable,
                    vec!["selection_changed".to_string()],
                );
            }
        },
        DiscardSelection::Lines {
            old_start,
            old_lines,
            new_start,
            new_lines,
            lines,
            ..
        } => {
            let Some(hunk) = matching_hunk(diff, *old_start, *old_lines, *new_start, *new_lines)
            else {
                return (
                    Vec::new(),
                    Recoverability::NotRecoverable,
                    vec!["selection_changed".to_string()],
                );
            };
            let unique = lines
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>();
            if unique.is_empty() || unique.iter().any(|line| *line as usize >= hunk.lines.len()) {
                return (
                    Vec::new(),
                    Recoverability::NotRecoverable,
                    vec!["selection_changed".to_string()],
                );
            }
            unique
                .into_iter()
                .filter(|line| hunk.lines[*line as usize].kind != DiffLineKind::Context)
                .count() as u32
        }
    };

    if selected_count == 0 {
        return (
            Vec::new(),
            Recoverability::NotRecoverable,
            vec!["no_changes_selected".to_string()],
        );
    }

    let path = selection.path().to_string();
    let mut consequences = Vec::new();
    if matches!(selection, DiscardSelection::File { .. }) {
        if diff.change_type == FileChangeType::Added {
            consequences.push(Consequence::UntrackedFilesDeleted {
                count: 1,
                sample: vec![path.clone()],
            });
        } else {
            consequences.push(Consequence::ModifiedFilesDiscarded {
                count: 1,
                sample: vec![path.clone()],
            });
        }
    }
    consequences.push(Consequence::ModifiedLinesDiscarded {
        path,
        count: selected_count,
    });
    (consequences, Recoverability::NotRecoverable, Vec::new())
}

fn matching_hunk(
    diff: &FileDiffDetail,
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
) -> Option<&DiffHunk> {
    diff.hunks.iter().find(|hunk| {
        hunk.old_start == old_start
            && hunk.old_lines == old_lines
            && hunk.new_start == new_start
            && hunk.new_lines == new_lines
    })
}

fn changed_line_count(hunk: &DiffHunk) -> u32 {
    hunk.lines
        .iter()
        .filter(|line| line.kind != DiffLineKind::Context)
        .count() as u32
}

/// Read-side git queries scoped by `RepositoryId` rather than a raw path —
/// this is the layer that resolves "which repo is this" (via
/// `WorkspaceStore`) before ever calling into `GitBackend`, so command
/// handlers and the frontend only ever deal in IDs (SDD §5.1, §7).
pub struct RepoService {
    workspaces: Arc<dyn WorkspaceStore>,
    settings: Arc<dyn SettingsStore>,
    git: Arc<dyn GitBackend>,
    #[allow(dead_code)]
    remote: Arc<dyn GitRemoteBackend>,
    environment: Arc<dyn GitEnvironmentProvider>,
    ide: Arc<dyn IdeLauncher>,
}

impl RepoService {
    pub fn new(
        workspaces: Arc<dyn WorkspaceStore>,
        settings: Arc<dyn SettingsStore>,
        git: Arc<dyn GitBackend>,
        remote: Arc<dyn GitRemoteBackend>,
        environment: Arc<dyn GitEnvironmentProvider>,
        ide: Arc<dyn IdeLauncher>,
    ) -> Self {
        Self {
            workspaces,
            settings,
            git,
            remote,
            environment,
            ide,
        }
    }

    /// Display name for an operation's UI, e.g. the repository an
    /// authentication prompt belongs to. Absent rather than fatal: a prompt is
    /// still shown for a repository that vanished from the store.
    pub async fn repository_name(&self, repo_id: RepositoryId) -> Option<String> {
        self.workspaces
            .get_repository(repo_id)
            .await
            .ok()
            .map(|repo| repo.name)
    }

    pub async fn get_generations(&self, repo_id: RepositoryId) -> Result<GenerationSet, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.generations(&RepoPath::new(repo.path))?)
    }

    pub async fn load_repository_snapshot(
        &self,
        repo_id: RepositoryId,
    ) -> Result<Option<StoredRepositorySnapshot>, RepoError> {
        Ok(self
            .workspaces
            .load_repository_snapshot(repo_id, SNAPSHOT_SCHEMA_VERSION)
            .await?)
    }

    /// Captures a coherent read projection. A mutation between any of the Git
    /// reads invalidates the attempt, so a stored snapshot never combines two
    /// repository generations.
    pub async fn capture_repository_snapshot(
        &self,
        repo_id: RepositoryId,
    ) -> Result<StoredRepositorySnapshot, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let path = RepoPath::new(repo.path);

        for _ in 0..SNAPSHOT_CAPTURE_ATTEMPTS {
            let before = self.git.generations(&path)?;
            let (status, operation_state, branches, tags, first_history_page, working_changes) = tokio::try_join!(
                self.git.status(&path),
                self.git.operation_state(&path),
                self.git.branches(&path),
                self.git.tags(&path),
                self.git.log(&path, None, 30),
                self.git.working_changes(&path),
            )?;
            let after = self.git.generations(&path)?;

            if before == after {
                let snapshot = RepositorySnapshot {
                    status,
                    operation_state,
                    branches,
                    tags,
                    first_history_page,
                    working_changes,
                    generations: after,
                };
                return Ok(self
                    .workspaces
                    .upsert_repository_snapshot(repo_id, SNAPSHOT_SCHEMA_VERSION, &snapshot)
                    .await?);
            }
        }

        Err(RepoError::SnapshotChangedDuringCapture)
    }

    pub async fn revalidate_repository_snapshot(
        &self,
        repo_id: RepositoryId,
    ) -> Result<SnapshotRevalidation, RepoError> {
        let previous = self.load_repository_snapshot(repo_id).await?;
        let snapshot = self.capture_repository_snapshot(repo_id).await?;
        let changed = previous
            .as_ref()
            .is_none_or(|stored| stored.snapshot != snapshot.snapshot);

        Ok(SnapshotRevalidation { snapshot, changed })
    }

    pub async fn get_branches(&self, repo_id: RepositoryId) -> Result<Vec<BranchInfo>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.branches(&RepoPath::new(repo.path)).await?)
    }

    pub async fn get_tags(&self, repo_id: RepositoryId) -> Result<Vec<TagInfo>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.tags(&RepoPath::new(repo.path)).await?)
    }

    pub async fn get_status(&self, repo_id: RepositoryId) -> Result<RepoStatus, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.status(&RepoPath::new(repo.path)).await?)
    }

    pub async fn get_operation_state(
        &self,
        repo_id: RepositoryId,
    ) -> Result<RepoOperationState, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.operation_state(&RepoPath::new(repo.path)).await?)
    }

    pub async fn continue_operation(
        &self,
        repo_id: RepositoryId,
    ) -> Result<RepoOperationState, RepoError> {
        self.continue_operation_with_context(repo_id, GitOperationContext::default())
            .await
    }

    pub async fn continue_operation_with_context(
        &self,
        repo_id: RepositoryId,
        context: GitOperationContext,
    ) -> Result<RepoOperationState, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .continue_operation_with_context(&RepoPath::new(repo.path), context)
            .await?)
    }

    pub async fn skip_operation(
        &self,
        repo_id: RepositoryId,
    ) -> Result<RepoOperationState, RepoError> {
        self.skip_operation_with_context(repo_id, GitOperationContext::default())
            .await
    }

    pub async fn skip_operation_with_context(
        &self,
        repo_id: RepositoryId,
        context: GitOperationContext,
    ) -> Result<RepoOperationState, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .skip_operation_with_context(&RepoPath::new(repo.path), context)
            .await?)
    }

    pub async fn get_git_environment(&self) -> Result<GitEnvironmentInfo, RepoError> {
        let settings = self.settings.get_settings().await?;
        Ok(self
            .environment
            .inspect(settings.git_executable_path.as_deref())
            .await?)
    }

    pub async fn set_git_executable_path(
        &self,
        path: PathBuf,
    ) -> Result<GitEnvironmentInfo, RepoError> {
        let info = self.environment.inspect(Some(&path)).await?;
        if !info.configured_path_valid {
            // Never store a path that does not run. The old code persisted
            // whatever `inspect` accepted, which could not happen before only
            // because inspection failed outright.
            return Err(GitEnvironmentError::InvalidConfiguredPath.into());
        }
        let mut settings = self.settings.get_settings().await?;
        settings.git_executable_path = Some(path);
        self.settings.update_settings(&settings).await?;
        self.git.set_git_executable(resolution_of(&info));
        Ok(info)
    }

    pub async fn reset_git_executable_path(&self) -> Result<GitEnvironmentInfo, RepoError> {
        let mut settings = self.settings.get_settings().await?;
        settings.git_executable_path = None;
        self.settings.update_settings(&settings).await?;
        let info = self.environment.inspect(None).await?;
        self.git.set_git_executable(resolution_of(&info));
        Ok(info)
    }

    /// Applies the stored executable setting to the local backend. Called once
    /// at startup so local and remote operations run the same Git from the
    /// first command, not only after the user visits Settings.
    ///
    /// A configured path that fails validation makes local subprocess commands
    /// *unavailable* rather than falling back to `PATH`: remote transport
    /// already fails in that situation, and half an application on a different
    /// Git than the user chose is worse than a clear failure (P5-20).
    pub async fn refresh_git_executable(&self) {
        let configured = match self.settings.get_settings().await {
            Ok(settings) => settings.git_executable_path,
            Err(error) => {
                tracing::warn!(%error, "could not read the Git executable setting");
                return;
            }
        };
        match self.environment.inspect(configured.as_deref()).await {
            Ok(info) => {
                if !info.configured_path_valid {
                    tracing::warn!(
                        "the configured Git executable is invalid; local Git commands are unavailable"
                    );
                }
                self.git.set_git_executable(resolution_of(&info));
            }
            Err(error) => {
                tracing::warn!(%error, "could not resolve a Git executable for local operations");
                self.git
                    .set_git_executable(GitExecutableResolution::Unavailable);
            }
        }
    }

    pub async fn test_git_connection(
        &self,
        repo_id: RepositoryId,
        remote: &str,
    ) -> Result<GitConnectionTestResult, RepoError> {
        self.test_git_connection_with_context(repo_id, remote, GitOperationContext::default())
            .await
    }

    pub async fn test_git_connection_with_context(
        &self,
        repo_id: RepositoryId,
        remote: &str,
        context: GitOperationContext,
    ) -> Result<GitConnectionTestResult, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let settings = self.settings.get_settings().await?;
        Ok(self
            .environment
            .test_connection(
                &RepoPath::new(repo.path),
                remote,
                context.with_git_executable_path(settings.git_executable_path),
            )
            .await?)
    }

    pub async fn get_commit_log(
        &self,
        repo_id: RepositoryId,
        cursor: Option<LogCursor>,
        limit: u32,
    ) -> Result<CommitPage, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .log(&RepoPath::new(repo.path), cursor, limit)
            .await?)
    }

    pub async fn get_reflog(
        &self,
        repo_id: RepositoryId,
        ref_name: Option<&str>,
        cursor: Option<LogCursor>,
        limit: u32,
    ) -> Result<ReflogPage, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .reflog(&RepoPath::new(repo.path), ref_name, cursor, limit)
            .await?)
    }

    pub async fn get_reflog_refs(&self, repo_id: RepositoryId) -> Result<Vec<String>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.reflog_refs(&RepoPath::new(repo.path)).await?)
    }

    pub async fn search_commit_log(
        &self,
        repo_id: RepositoryId,
        query: &str,
        limit: u32,
    ) -> Result<Vec<CommitSummary>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .search_commits(&RepoPath::new(repo.path), query, limit)
            .await?)
    }

    pub async fn global_search(
        &self,
        workspace_id: Option<WorkspaceId>,
        query: &str,
        limit: u32,
    ) -> Result<Vec<GlobalSearchResult>, RepoError> {
        let query = query.trim().to_lowercase();
        if query.is_empty() || limit == 0 {
            return Ok(vec![]);
        }

        let repos = match workspace_id {
            Some(workspace_id) => self.workspaces.list_repositories(workspace_id).await?,
            None => self.workspaces.list_all_repositories().await?,
        };

        // Repositories are searched concurrently through the same bounded
        // pool as bulk operations (docs/tasks.md P4-13) — the wall-clock
        // cost tracks the slowest repo, not the sum. Each repo caps its own
        // hits at `limit`; the merged list preserves the store's repository
        // order (so results stay deterministic) before the global cut.
        let semaphore = std::sync::Arc::new(Semaphore::new(BULK_WORKER_LIMIT));
        let mut tasks = JoinSet::new();

        for (index, repo) in repos.into_iter().enumerate() {
            let permit = semaphore
                .clone()
                .acquire_owned()
                .await
                .expect("search semaphore should stay open");
            let git = self.git.clone();
            let query = query.clone();
            tasks.spawn(async move {
                let hits = search_repository(git, repo, &query, limit as usize).await;
                drop(permit);
                (index, hits)
            });
        }

        let mut per_repo = Vec::new();
        while let Some(result) = tasks.join_next().await {
            if let Ok(entry) = result {
                per_repo.push(entry);
            }
        }
        per_repo.sort_by_key(|(index, _)| *index);

        let mut results: Vec<GlobalSearchResult> =
            per_repo.into_iter().flat_map(|(_, hits)| hits).collect();
        results.truncate(limit as usize);
        Ok(results)
    }

    pub async fn get_commit_diff(
        &self,
        repo_id: RepositoryId,
        commit_id: &str,
    ) -> Result<Vec<FileDiff>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.diff(&RepoPath::new(repo.path), commit_id).await?)
    }

    pub async fn get_recovery_diff(
        &self,
        repo_id: RepositoryId,
        commit_id: &str,
    ) -> Result<Vec<FileDiff>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .diff_against_head(&RepoPath::new(repo.path), commit_id)
            .await?)
    }

    pub async fn get_commit_files(
        &self,
        repo_id: RepositoryId,
        commit_id: &str,
    ) -> Result<Vec<FileDiff>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .diff_files(&RepoPath::new(repo.path), commit_id)
            .await?)
    }

    pub async fn get_file_diff(
        &self,
        repo_id: RepositoryId,
        commit_id: &str,
        path: &str,
        options: DiffRequestOptions,
    ) -> Result<FileDiffWindow, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let window = self
            .git
            .file_diff_window(
                &RepoPath::new(repo.path),
                commit_id,
                path,
                DiffWindowOptions {
                    offset: options.offset,
                    limit: normalized_diff_limit(options.limit),
                    max_file_bytes: if options.load_anyway {
                        u64::MAX
                    } else {
                        DIFF_FILE_MAX_BYTES
                    },
                    whitespace: options.whitespace,
                },
            )
            .await?;
        ensure_diff_response_ceiling(window)
    }

    pub async fn checkout_branch(
        &self,
        repo_id: RepositoryId,
        branch: &str,
    ) -> Result<(), RepoError> {
        self.checkout_branch_with_context(repo_id, branch, GitOperationContext::default())
            .await
    }

    pub async fn checkout_branch_with_context(
        &self,
        repo_id: RepositoryId,
        branch: &str,
        context: GitOperationContext,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let repo_path = RepoPath::new(repo.path);
        let overwrite_paths = self
            .git
            .checkout_overwrite_paths(&repo_path, branch)
            .await?;
        if !overwrite_paths.is_empty() {
            return Err(GitError::CheckoutWouldOverwrite {
                paths: overwrite_paths,
            }
            .into());
        }
        if let Some((remote, refspec)) =
            self.git.remote_checkout_refspec(&repo_path, branch).await?
        {
            let settings = self.settings.get_settings().await?;
            self.remote
                .fetch(
                    &repo_path,
                    &remote,
                    &[refspec],
                    context.with_git_executable_path(settings.git_executable_path),
                )
                .await?;
        }
        Ok(self.git.checkout_local(&repo_path, branch).await?)
    }

    pub async fn stash_and_checkout_with_context(
        &self,
        repo_id: RepositoryId,
        branch: &str,
        context: GitOperationContext,
    ) -> Result<String, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let repo_path = RepoPath::new(repo.path);
        let source = self
            .git
            .status(&repo_path)
            .await?
            .branch
            .unwrap_or_else(|| "HEAD".to_string());
        if let Some((remote, refspec)) =
            self.git.remote_checkout_refspec(&repo_path, branch).await?
        {
            let settings = self.settings.get_settings().await?;
            self.remote
                .fetch(
                    &repo_path,
                    &remote,
                    &[refspec],
                    context.with_git_executable_path(settings.git_executable_path),
                )
                .await?;
        }
        let message = format!("Fjord checkout: {source} -> {branch}");
        self.git
            .stash_and_checkout(&repo_path, branch, &message)
            .await?;
        Ok("stash@{0}".to_string())
    }

    pub async fn get_working_changes(
        &self,
        repo_id: RepositoryId,
    ) -> Result<WorkingChanges, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.working_changes(&RepoPath::new(repo.path)).await?)
    }

    pub async fn get_working_file_diff(
        &self,
        repo_id: RepositoryId,
        path: &str,
        staged: bool,
        options: DiffRequestOptions,
    ) -> Result<FileDiffWindow, RepoError> {
        Ok(self
            .get_working_file_diff_versioned(repo_id, path, staged, options)
            .await?
            .0)
    }

    /// Captures the rendered working diff and its existing runtime generation
    /// as one coherent read. This mirrors P8-00 preflight capture: a watcher or
    /// mutation racing the diff causes a retry, never a stale diff stamped with
    /// a newer generation.
    pub async fn get_working_file_diff_versioned(
        &self,
        repo_id: RepositoryId,
        path: &str,
        staged: bool,
        options: DiffRequestOptions,
    ) -> Result<(FileDiffWindow, GenerationSet), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let repo = RepoPath::new(repo.path);
        for _ in 0..PATCH_DIFF_CAPTURE_ATTEMPTS {
            let before = self.git.generations(&repo)?;
            let window = self
                .git
                .working_file_diff_window(
                    &repo,
                    path,
                    staged,
                    DiffWindowOptions {
                        offset: options.offset,
                        limit: normalized_diff_limit(options.limit),
                        max_file_bytes: if options.load_anyway {
                            u64::MAX
                        } else {
                            DIFF_FILE_MAX_BYTES
                        },
                        whitespace: options.whitespace,
                    },
                )
                .await?;
            let after = self.git.generations(&repo)?;
            if before == after {
                return Ok((ensure_diff_response_ceiling(window)?, after));
            }
        }
        Err(GitError::PatchStale.into())
    }

    /// Computes bounded, concrete consequences against one coherent generation
    /// stamp. If Git changes during inspection, the facts are discarded and
    /// recomputed rather than returned stale.
    pub async fn preflight_destructive_action(
        &self,
        repo_id: RepositoryId,
        action: DestructiveAction,
        patch_selection: Option<PatchSelection>,
    ) -> Result<DestructivePreflight, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let path = RepoPath::new(repo.path);

        for _ in 0..PREFLIGHT_CAPTURE_ATTEMPTS {
            let before = self.git.generations(&path)?;
            let mut force_plan = None;
            let (consequences, recoverable, blockers) = match &action {
                DestructiveAction::Discard { selection } => {
                    let diff = self
                        .git
                        .working_file_diff(&path, selection.path(), false)
                        .await?;
                    discard_consequences(selection, &diff)
                }
                DestructiveAction::ForceWithLease => {
                    let plan = self.git.force_push_plan(&path).await?;
                    let (count, mut sample) = self
                        .git
                        .commits_unreachable_from_head(
                            &path,
                            &plan.expected_oid,
                            PREFLIGHT_SAMPLE_LIMIT as u32,
                        )
                        .await?;
                    sample.truncate(PREFLIGHT_SAMPLE_LIMIT);
                    let mut consequences = vec![Consequence::RemoteRefUpdated {
                        remote: plan.remote.clone(),
                        ref_name: plan.remote_ref.clone(),
                        dropped_commits: count,
                    }];
                    if count > 0 {
                        consequences.push(Consequence::CommitsUnreachable { count, sample });
                    }
                    force_plan = Some(plan);
                    // A remote server is not required to retain a reflog, so
                    // force-push recovery cannot be promised by Fjord.
                    (consequences, Recoverability::NotRecoverable, Vec::new())
                }
                DestructiveAction::Reset { .. }
                | DestructiveAction::DeleteBranch { .. }
                | DestructiveAction::DeleteRemoteBranch { .. }
                | DestructiveAction::DeleteTag { .. }
                | DestructiveAction::StashPop { .. }
                | DestructiveAction::CheckoutDiscard { .. }
                | DestructiveAction::AbortOperation
                | DestructiveAction::RecoveryRestore { .. } => {
                    let facts = self
                        .git
                        .destructive_action_facts(&path, &action, PREFLIGHT_SAMPLE_LIMIT as u32)
                        .await?;
                    (facts.consequences, facts.recoverable, facts.blockers)
                }
            };
            let after = self.git.generations(&path)?;
            if before == after {
                let confirmation_token = if blockers.is_empty() {
                    if matches!(action, DestructiveAction::Discard { .. }) {
                        let selection = patch_selection.as_ref().ok_or(GitError::PreflightStale)?;
                        match self
                            .git
                            .issue_discard_confirmation(&path, &action, selection, after)
                            .await
                        {
                            Ok(token) => Some(token),
                            Err(GitError::PreflightStale | GitError::PatchStale) => continue,
                            Err(error) => return Err(error.into()),
                        }
                    } else if matches!(action, DestructiveAction::ForceWithLease) {
                        let plan = force_plan.as_ref().ok_or(GitError::PreflightStale)?;
                        match self
                            .git
                            .issue_force_push_confirmation(&path, &action, plan, after)
                            .await
                        {
                            Ok(token) => Some(token),
                            Err(GitError::PreflightStale | GitError::PatchStale) => continue,
                            Err(error) => return Err(error.into()),
                        }
                    } else {
                        match self
                            .git
                            .issue_action_confirmation(&path, &action, after)
                            .await
                        {
                            Ok(token) => Some(token),
                            Err(GitError::PreflightStale | GitError::PatchStale) => continue,
                            Err(error) => return Err(error.into()),
                        }
                    }
                } else {
                    None
                };
                let force_with_lease = force_plan.as_ref().map(|plan| ForceWithLeaseDetails {
                    remote: plan.remote.clone(),
                    ref_name: plan.remote_ref.clone(),
                    expected_oid: fjord_domain::CommitId(plan.expected_oid.clone()),
                });
                return Ok(DestructivePreflight {
                    action,
                    consequences,
                    recoverable,
                    blockers,
                    generations: after,
                    force_with_lease,
                    confirmation_token,
                });
            }
        }

        Err(RepoError::PreflightChangedDuringCapture)
    }

    /// Executes only the exact action confirmed by the backend-issued token.
    /// Local mutations consume and act under one repository write lock; remote
    /// deletion consumes the same binding before entering transport.
    pub async fn execute_destructive_action(
        &self,
        repo_id: RepositoryId,
        action: &DestructiveAction,
        expected_generations: GenerationSet,
        confirmation_token: &str,
        context: GitOperationContext,
    ) -> Result<Option<RepoOperationState>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let path = RepoPath::new(repo.path);
        if let DestructiveAction::DeleteRemoteBranch { remote, branch } = action {
            self.git
                .consume_action_confirmation(
                    &path,
                    action,
                    expected_generations,
                    confirmation_token,
                )
                .await?;
            let settings = self.settings.get_settings().await?;
            self.remote
                .delete_remote_branch(
                    &path,
                    remote,
                    branch,
                    context.with_git_executable_path(settings.git_executable_path),
                )
                .await?;
            return Ok(None);
        }
        Ok(self
            .git
            .execute_confirmed_destructive_action(
                &path,
                action,
                expected_generations,
                confirmation_token,
                context,
            )
            .await?)
    }

    pub async fn create_branch(
        &self,
        repo_id: RepositoryId,
        name: &str,
        checkout: bool,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .create_branch(&RepoPath::new(repo.path), name, checkout)
            .await?)
    }

    pub async fn create_branch_at(
        &self,
        repo_id: RepositoryId,
        name: &str,
        target: &str,
        checkout: bool,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .create_branch_at(&RepoPath::new(repo.path), name, target, checkout)
            .await?)
    }

    pub async fn rename_branch(
        &self,
        repo_id: RepositoryId,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .rename_branch(&RepoPath::new(repo.path), old_name, new_name)
            .await?)
    }

    pub async fn set_branch_upstream(
        &self,
        repo_id: RepositoryId,
        branch: &str,
        upstream: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .set_branch_upstream(&RepoPath::new(repo.path), branch, upstream)
            .await?)
    }

    pub async fn unset_branch_upstream(
        &self,
        repo_id: RepositoryId,
        branch: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .unset_branch_upstream(&RepoPath::new(repo.path), branch)
            .await?)
    }

    pub async fn create_tag(
        &self,
        repo_id: RepositoryId,
        name: &str,
        target: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .create_tag(&RepoPath::new(repo.path), name, target)
            .await?)
    }

    pub async fn cherry_pick(
        &self,
        repo_id: RepositoryId,
        commit_id: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .cherry_pick(&RepoPath::new(repo.path), commit_id)
            .await?)
    }

    pub async fn revert(&self, repo_id: RepositoryId, commit_id: &str) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .revert(&RepoPath::new(repo.path), commit_id)
            .await?)
    }

    pub async fn get_stashes(&self, repo_id: RepositoryId) -> Result<Vec<StashEntry>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.stashes(&RepoPath::new(repo.path)).await?)
    }

    pub async fn stash_push(
        &self,
        repo_id: RepositoryId,
        message: Option<&str>,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .stash_push(&RepoPath::new(repo.path), message)
            .await?)
    }

    pub async fn open_terminal(&self, repo_id: RepositoryId) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.ide.open_terminal(&repo.path).await?)
    }

    pub async fn stage_files(
        &self,
        repo_id: RepositoryId,
        paths: &[PathBuf],
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.stage(&RepoPath::new(repo.path), paths).await?)
    }

    pub async fn stage_patch(
        &self,
        repo_id: RepositoryId,
        selection: &PatchSelection,
        expected_generations: GenerationSet,
    ) -> Result<GenerationSet, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .stage_patch(&RepoPath::new(repo.path), selection, expected_generations)
            .await?)
    }

    pub async fn unstage_files(
        &self,
        repo_id: RepositoryId,
        paths: &[PathBuf],
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.unstage(&RepoPath::new(repo.path), paths).await?)
    }

    pub async fn unstage_patch(
        &self,
        repo_id: RepositoryId,
        selection: &PatchSelection,
        expected_generations: GenerationSet,
    ) -> Result<GenerationSet, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .unstage_patch(&RepoPath::new(repo.path), selection, expected_generations)
            .await?)
    }

    pub async fn discard_patch(
        &self,
        repo_id: RepositoryId,
        action: &DestructiveAction,
        selection: &PatchSelection,
        expected_generations: GenerationSet,
        confirmation_token: &str,
    ) -> Result<GenerationSet, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .discard_patch(
                &RepoPath::new(repo.path),
                action,
                selection,
                expected_generations,
                confirmation_token,
            )
            .await?)
    }

    pub async fn amend_info(
        &self,
        repo_id: RepositoryId,
    ) -> Result<fjord_domain::AmendInfo, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.amend_info(&RepoPath::new(repo.path)).await?)
    }

    pub async fn commit(
        &self,
        repo_id: RepositoryId,
        message: &str,
        amend: bool,
    ) -> Result<String, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let repo_path = RepoPath::new(repo.path);
        if amend {
            Ok(self.git.amend(&repo_path, message).await?)
        } else {
            Ok(self.git.commit(&repo_path, message).await?)
        }
    }

    /// Creates the commit first, then attempts its push. Once commit creation
    /// succeeds, a push failure is returned as a partial outcome and is never
    /// used to roll local history back.
    pub async fn commit_and_push_with_context(
        &self,
        repo_id: RepositoryId,
        message: &str,
        amend: bool,
        context: GitOperationContext,
    ) -> Result<CommitPushOutcome, RepoError> {
        let commit_id = self.commit(repo_id, message, amend).await?;
        let push_error = self.push_with_context(repo_id, context).await.err();
        Ok(CommitPushOutcome {
            commit_id,
            push_error,
        })
    }

    pub async fn fetch(&self, repo_id: RepositoryId, remote: &str) -> Result<(), RepoError> {
        self.fetch_with_context(repo_id, remote, GitOperationContext::default())
            .await
    }

    pub async fn fetch_with_context(
        &self,
        repo_id: RepositoryId,
        remote: &str,
        context: GitOperationContext,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let settings = self.settings.get_settings().await?;
        let context = context.with_git_executable_path(settings.git_executable_path);
        Ok(self
            .remote
            .fetch(&RepoPath::new(repo.path), remote, &[], context)
            .await?)
    }

    pub async fn pull(&self, repo_id: RepositoryId) -> Result<(), RepoError> {
        self.pull_with_context(repo_id, GitOperationContext::default())
            .await
    }

    pub async fn pull_with_context(
        &self,
        repo_id: RepositoryId,
        context: GitOperationContext,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let repo_path = RepoPath::new(repo.path);
        let remote = self.git.upstream_remote(&repo_path).await?;
        let settings = self.settings.get_settings().await?;
        let context = context.with_git_executable_path(settings.git_executable_path);
        self.remote
            .fetch(&repo_path, &remote, &[], context.clone())
            .await?;
        if context.is_cancelled() {
            return Err(GitError::Cancelled.into());
        }
        Ok(self.git.integrate_upstream(&repo_path).await?)
    }

    pub async fn push(&self, repo_id: RepositoryId) -> Result<(), RepoError> {
        self.push_with_context(repo_id, GitOperationContext::default())
            .await
    }

    /// Pushes to the branch's configured upstream. A branch without one fails
    /// with [`GitError::NoUpstream`] instead of guessing `origin`, so the user
    /// publishes it explicitly through [`Self::publish_branch_with_context`].
    pub async fn push_with_context(
        &self,
        repo_id: RepositoryId,
        context: GitOperationContext,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let repo_path = RepoPath::new(repo.path);
        let target = self.git.current_push_target(&repo_path).await?;
        let settings = self.settings.get_settings().await?;
        let context = context.with_git_executable_path(settings.git_executable_path);
        Ok(self
            .remote
            .push(&repo_path, &target.remote, &[target.refspec()], context)
            .await?)
    }

    pub async fn force_push_with_context(
        &self,
        repo_id: RepositoryId,
        expected_generations: GenerationSet,
        confirmation_token: &str,
        context: GitOperationContext,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let repo_path = RepoPath::new(repo.path);
        let plan = self
            .git
            .consume_force_push_confirmation(
                &repo_path,
                &DestructiveAction::ForceWithLease,
                expected_generations,
                confirmation_token,
            )
            .await?;
        let settings = self.settings.get_settings().await?;
        let context = context.with_git_executable_path(settings.git_executable_path);
        Ok(self
            .remote
            .force_push_with_lease(
                &repo_path,
                &plan.remote,
                &plan.source_oid,
                &plan.remote_ref,
                &plan.expected_oid,
                context,
            )
            .await?)
    }

    pub async fn publish_branch(
        &self,
        repo_id: RepositoryId,
        remote: Option<&str>,
    ) -> Result<(), RepoError> {
        self.publish_branch_with_context(repo_id, remote, GitOperationContext::default())
            .await
    }

    pub async fn publish_branch_with_context(
        &self,
        repo_id: RepositoryId,
        remote: Option<&str>,
        context: GitOperationContext,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let repo_path = RepoPath::new(repo.path);
        let branch_ref = self.git.current_branch_ref(&repo_path).await?;
        let settings = self.settings.get_settings().await?;
        let context = context.with_git_executable_path(settings.git_executable_path);
        Ok(self
            .remote
            .publish_branch(
                &repo_path,
                remote.unwrap_or(DEFAULT_PUBLISH_REMOTE),
                &branch_ref,
                context,
            )
            .await?)
    }

    pub async fn open_merge_tool(&self, repo_id: RepositoryId) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.open_merge_tool(&RepoPath::new(repo.path)).await?)
    }

    pub async fn open_in_ide(
        &self,
        repo_id: RepositoryId,
        ide: Option<&str>,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        let settings = self.settings.get_settings().await?;
        let configured_ide = ide.or(settings.default_ide.as_deref());
        Ok(self.ide.open(&repo.path, configured_ide).await?)
    }

    pub async fn bulk_fetch(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<BulkRepoResult>, RepoError> {
        let repos = self.workspaces.list_repositories(workspace_id).await?;
        let settings = self.settings.get_settings().await?;
        let git_executable_path = settings.git_executable_path.map(Arc::new);
        Ok(run_bulk(repos, {
            let remote = self.remote.clone();
            move |repo| {
                let remote = remote.clone();
                let git_executable_path = git_executable_path.clone();
                async move {
                    remote
                        .fetch(
                            &RepoPath::new(repo.path),
                            "origin",
                            &[],
                            GitOperationContext::default()
                                .with_git_executable_path(git_executable_path.as_deref().cloned()),
                        )
                        .await
                        .map_err(|e| e.to_string())
                }
            }
        })
        .await)
    }

    pub async fn bulk_pull(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<BulkRepoResult>, RepoError> {
        let repos = self.workspaces.list_repositories(workspace_id).await?;
        let settings = self.settings.get_settings().await?;
        let git_executable_path = settings.git_executable_path.map(Arc::new);
        Ok(run_bulk(repos, {
            let git = self.git.clone();
            let remote_backend = self.remote.clone();
            move |repo| {
                let git = git.clone();
                let remote_backend = remote_backend.clone();
                let git_executable_path = git_executable_path.clone();
                async move {
                    let repo_path = RepoPath::new(repo.path);
                    let remote = git
                        .upstream_remote(&repo_path)
                        .await
                        .map_err(|error| error.to_string())?;
                    remote_backend
                        .fetch(
                            &repo_path,
                            &remote,
                            &[],
                            GitOperationContext::default()
                                .with_git_executable_path(git_executable_path.as_deref().cloned()),
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    git.integrate_upstream(&repo_path)
                        .await
                        .map_err(|error| error.to_string())
                }
            }
        })
        .await)
    }

    pub async fn bulk_open_in_ide(
        &self,
        workspace_id: WorkspaceId,
        ide: Option<&str>,
    ) -> Result<Vec<BulkRepoResult>, RepoError> {
        let repos = self.workspaces.list_repositories(workspace_id).await?;
        let settings = self.settings.get_settings().await?;
        let configured_ide = ide
            .map(ToString::to_string)
            .or(settings.default_ide)
            .map(std::sync::Arc::new);

        Ok(run_bulk(repos, {
            let launcher = self.ide.clone();
            move |repo| {
                let launcher = launcher.clone();
                let configured_ide = configured_ide.clone();
                async move {
                    launcher
                        .open(&repo.path, configured_ide.as_deref().map(String::as_str))
                        .await
                        .map_err(|e| e.to_string())
                }
            }
        })
        .await)
    }
}

fn matches_search<'a, I>(query: &str, values: I) -> bool
where
    I: IntoIterator<Item = &'a str>,
{
    values
        .into_iter()
        .any(|value| value.to_lowercase().contains(query))
}

/// Searches a single repository's name/path, branches, and a bounded slice
/// of recent commits. `query` is already trimmed and lowercased. Hits are
/// capped at `limit` — the caller applies the global limit after merging.
async fn search_repository(
    git: std::sync::Arc<dyn GitBackend>,
    repo: RepositoryEntry,
    query: &str,
    limit: usize,
) -> Vec<GlobalSearchResult> {
    let mut hits = Vec::new();

    let repo_path_text = repo.path.to_string_lossy().to_string();
    if matches_search(query, [repo.name.as_str(), repo_path_text.as_str()]) {
        hits.push(GlobalSearchResult {
            kind: SearchResultKind::Repository,
            repo_id: repo.id,
            workspace_id: repo.workspace_id,
            repo_name: repo.name.clone(),
            repo_path: repo.path.clone(),
            branch: None,
            commit: None,
        });
    }

    let repo_path = RepoPath::new(repo.path.clone());
    if let Ok(branches) = git.branches(&repo_path).await {
        for branch in branches {
            if hits.len() >= limit {
                return hits;
            }
            if matches_search(query, [branch.name.as_str()]) {
                hits.push(GlobalSearchResult {
                    kind: SearchResultKind::Branch,
                    repo_id: repo.id,
                    workspace_id: repo.workspace_id,
                    repo_name: repo.name.clone(),
                    repo_path: repo.path.clone(),
                    branch: Some(branch.name),
                    commit: None,
                });
            }
        }
    }

    if hits.len() >= limit {
        return hits;
    }

    if let Ok(page) = git.log(&repo_path, None, SEARCH_COMMIT_SCAN_LIMIT).await {
        for commit in page.commits {
            if hits.len() >= limit {
                break;
            }
            let commit_id = commit.id.0.as_str();
            if matches_search(
                query,
                [
                    commit_id,
                    commit.message.as_str(),
                    commit.author_name.as_str(),
                    commit.author_email.as_str(),
                ],
            ) {
                hits.push(GlobalSearchResult {
                    kind: SearchResultKind::Commit,
                    repo_id: repo.id,
                    workspace_id: repo.workspace_id,
                    repo_name: repo.name.clone(),
                    repo_path: repo.path.clone(),
                    branch: None,
                    commit: Some(commit),
                });
            }
        }
    }

    hits
}

async fn run_bulk<F, Fut>(repos: Vec<RepositoryEntry>, operation: F) -> Vec<BulkRepoResult>
where
    F: Fn(RepositoryEntry) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
{
    let semaphore = std::sync::Arc::new(Semaphore::new(BULK_WORKER_LIMIT));
    let mut tasks = JoinSet::new();

    for repo in repos {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .expect("bulk semaphore should stay open");
        let operation = operation.clone();
        tasks.spawn(async move {
            let repo_id = repo.id;
            let result = operation(repo).await;
            drop(permit);
            BulkRepoResult {
                repo_id,
                ok: result.is_ok(),
                error: result.err(),
            }
        });
    }

    let mut results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Ok(result) = result {
            results.push(result);
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use fjord_domain::{
        CommitId, CommitPage, CommitSummary, Consequence, DestructiveAction, DiscardSelection,
        FileChangeType, FileDiff, FileDiffDetail, FileDiffWindow, GenerationSet, LogCursor,
        ReflogPage, RepoStatus, RepoStatusSummary, RepositoryEntry, Settings, StashEntry, TagInfo,
        WorkingChanges, WorkingFile, Workspace, WorkspaceId,
    };
    use fjord_ports::{DestructiveActionFacts, ForcePushPlan, PushTarget};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use time::OffsetDateTime;

    #[test]
    fn serialized_diff_windows_never_cross_the_response_ceiling() {
        let oversized = FileDiffWindow {
            path: "large.txt".to_string(),
            change_type: FileChangeType::Modified,
            old_mode: Some(0o100644),
            new_mode: Some(0o100644),
            is_binary: false,
            too_large: false,
            file_bytes: 0,
            hunks: vec![fjord_domain::DiffHunk {
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: vec![fjord_domain::DiffLine {
                    kind: fjord_domain::DiffLineKind::Addition,
                    old_lineno: None,
                    new_lineno: Some(1),
                    content: "x".repeat(DIFF_RESPONSE_MAX_BYTES),
                    line_ending: Some(fjord_domain::DiffLineEnding::Lf),
                }],
            }],
            total_hunks: 1,
            total_lines: 1,
            offset: 0,
            truncated: false,
            next_offset: None,
            base_digest: None,
        };

        assert!(matches!(
            ensure_diff_response_ceiling(oversized),
            Err(RepoError::DiffWindowTooLarge { .. })
        ));
    }

    struct FakeStore {
        repo: RepositoryEntry,
    }

    struct FakeSettingsStore {
        settings: Settings,
    }

    struct FakeIdeLauncher {
        opened: Mutex<Option<(PathBuf, Option<String>)>>,
        terminal_opened: Mutex<Option<PathBuf>>,
    }

    #[async_trait]
    impl WorkspaceStore for FakeStore {
        async fn list_workspaces(&self) -> Result<Vec<Workspace>, StoreError> {
            Ok(vec![])
        }
        async fn create_workspace(&self, _name: &str) -> Result<Workspace, StoreError> {
            unimplemented!()
        }
        async fn rename_workspace(
            &self,
            _id: WorkspaceId,
            _name: &str,
        ) -> Result<Workspace, StoreError> {
            unimplemented!()
        }
        async fn reorder_workspaces(&self, _ids: &[WorkspaceId]) -> Result<(), StoreError> {
            unimplemented!()
        }
        async fn delete_workspace(&self, _id: WorkspaceId) -> Result<(), StoreError> {
            unimplemented!()
        }
        async fn list_repositories(
            &self,
            _workspace_id: WorkspaceId,
        ) -> Result<Vec<RepositoryEntry>, StoreError> {
            Ok(vec![self.repo.clone()])
        }
        async fn list_all_repositories(&self) -> Result<Vec<RepositoryEntry>, StoreError> {
            Ok(vec![self.repo.clone()])
        }
        async fn get_repository(&self, id: RepositoryId) -> Result<RepositoryEntry, StoreError> {
            if id == self.repo.id {
                Ok(self.repo.clone())
            } else {
                Err(StoreError::RepositoryNotFound(id))
            }
        }
        async fn add_repository(
            &self,
            _workspace_id: WorkspaceId,
            _name: &str,
            _path: &Path,
        ) -> Result<RepositoryEntry, StoreError> {
            unimplemented!()
        }
        async fn remove_repository(&self, _id: RepositoryId) -> Result<(), StoreError> {
            unimplemented!()
        }
        async fn list_workspace_status(
            &self,
            _workspace_id: WorkspaceId,
        ) -> Result<Vec<RepoStatusSummary>, StoreError> {
            unimplemented!()
        }
        async fn upsert_repo_status(
            &self,
            _repo_id: RepositoryId,
            _status: &RepoStatus,
        ) -> Result<RepoStatusSummary, StoreError> {
            unimplemented!()
        }
        async fn invalidate_repo_status(&self, _repo_id: RepositoryId) -> Result<(), StoreError> {
            unimplemented!()
        }
    }

    #[async_trait]
    impl SettingsStore for FakeSettingsStore {
        async fn get_settings(&self) -> Result<Settings, StoreError> {
            Ok(self.settings.clone())
        }

        async fn update_settings(&self, settings: &Settings) -> Result<Settings, StoreError> {
            Ok(settings.clone())
        }
    }

    #[async_trait]
    impl IdeLauncher for FakeIdeLauncher {
        async fn open(&self, path: &Path, ide: Option<&str>) -> Result<(), LaunchError> {
            *self.opened.lock().unwrap() = Some((path.to_path_buf(), ide.map(ToString::to_string)));
            Ok(())
        }
        async fn open_terminal(&self, path: &Path) -> Result<(), LaunchError> {
            *self.terminal_opened.lock().unwrap() = Some(path.to_path_buf());
            Ok(())
        }
    }

    type RecordedDiscard = (
        PathBuf,
        DestructiveAction,
        PatchSelection,
        GenerationSet,
        String,
    );
    type RecordedDestructive = (PathBuf, DestructiveAction, GenerationSet, String);

    #[derive(Default)]
    struct FakeGit {
        seen_path: Arc<Mutex<Option<PathBuf>>>,
        generation_changes_on_first_preflight: bool,
        working_diff_calls: AtomicUsize,
        diff_window_options: Mutex<Vec<DiffWindowOptions>>,
        stage_patch_call: Mutex<Option<(PathBuf, PatchSelection, GenerationSet)>>,
        unstage_patch_call: Mutex<Option<(PathBuf, PatchSelection, GenerationSet)>>,
        discard_patch_call: Mutex<Option<RecordedDiscard>>,
        destructive_action_call: Mutex<Option<RecordedDestructive>>,
        reject_action_confirmation: bool,
        reject_force_confirmation: bool,
    }

    /// Remote and refspecs of one recorded call.
    type RecordedPush = (String, Vec<String>);

    #[derive(Default)]
    struct FakeRemoteGit {
        seen_path: Arc<Mutex<Option<PathBuf>>>,
        pushes: Arc<Mutex<Vec<RecordedPush>>>,
        publishes: Arc<Mutex<Vec<(String, String)>>>,
        deletes: Arc<Mutex<Vec<(String, String)>>>,
    }

    struct FakeEnvironment;

    #[async_trait]
    impl GitEnvironmentProvider for FakeEnvironment {
        async fn inspect(
            &self,
            _configured_path: Option<&Path>,
        ) -> Result<GitEnvironmentInfo, GitEnvironmentError> {
            Ok(GitEnvironmentInfo {
                executable_path: Some("git".into()),
                version: Some("test".into()),
                executable_source: None,
                configured_path_valid: true,
                credential_helpers: vec![],
                ssh_command: None,
                ssh_agent_available: false,
                proxy_configured: false,
                askpass_available: false,
            })
        }

        async fn test_connection(
            &self,
            _repo: &RepoPath,
            remote: &str,
            _context: GitOperationContext,
        ) -> Result<GitConnectionTestResult, GitRemoteError> {
            Ok(GitConnectionTestResult {
                success: true,
                duration_ms: 1,
                remote: remote.into(),
                protocol: fjord_domain::GitConnectionProtocol::Local,
                reference_count: 1,
            })
        }
    }

    #[async_trait]
    impl GitRemoteBackend for FakeRemoteGit {
        async fn fetch(
            &self,
            repo: &RepoPath,
            _remote: &str,
            _refspecs: &[String],
            _context: GitOperationContext,
        ) -> Result<(), GitRemoteError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }

        async fn push(
            &self,
            repo: &RepoPath,
            remote: &str,
            refspecs: &[String],
            _context: GitOperationContext,
        ) -> Result<(), GitRemoteError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            self.pushes
                .lock()
                .unwrap()
                .push((remote.to_string(), refspecs.to_vec()));
            Ok(())
        }

        async fn force_push_with_lease(
            &self,
            repo: &RepoPath,
            remote: &str,
            source_oid: &str,
            remote_ref: &str,
            expected_oid: &str,
            _context: GitOperationContext,
        ) -> Result<(), GitRemoteError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            self.pushes.lock().unwrap().push((
                remote.to_string(),
                vec![
                    format!("{source_oid}:{remote_ref}"),
                    expected_oid.to_string(),
                ],
            ));
            Ok(())
        }

        async fn publish_branch(
            &self,
            repo: &RepoPath,
            remote: &str,
            branch_ref: &str,
            _context: GitOperationContext,
        ) -> Result<(), GitRemoteError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            self.publishes
                .lock()
                .unwrap()
                .push((remote.to_string(), branch_ref.to_string()));
            Ok(())
        }

        async fn delete_remote_branch(
            &self,
            repo: &RepoPath,
            remote: &str,
            branch: &str,
            _context: GitOperationContext,
        ) -> Result<(), GitRemoteError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            self.deletes
                .lock()
                .unwrap()
                .push((remote.to_string(), branch.to_string()));
            Ok(())
        }

        async fn ls_remote(
            &self,
            _repo: &RepoPath,
            _remote: &str,
            _context: GitOperationContext,
        ) -> Result<Vec<fjord_domain::RemoteRef>, GitRemoteError> {
            Ok(vec![])
        }
    }

    fn repo_entry() -> RepositoryEntry {
        RepositoryEntry {
            id: RepositoryId::new(),
            workspace_id: WorkspaceId::new(),
            name: "api-gateway".into(),
            path: PathBuf::from("/repos/api-gateway"),
            sort_order: 0,
        }
    }

    fn fake_worktree_selection(lines: Vec<u32>) -> PatchSelection {
        PatchSelection {
            path: "src/main.rs".into(),
            source: fjord_domain::PatchSource::Worktree,
            hunks: vec![fjord_domain::HunkSelection {
                old_start: 1,
                old_lines: 2,
                new_start: 1,
                new_lines: 2,
                lines,
            }],
            base_digest: "digest".into(),
        }
    }

    fn fake_diff_window(path: &str) -> FileDiffWindow {
        FileDiffWindow {
            path: path.to_string(),
            change_type: FileChangeType::Modified,
            old_mode: Some(0o100644),
            new_mode: Some(0o100644),
            is_binary: false,
            too_large: false,
            file_bytes: 8,
            hunks: vec![],
            total_hunks: 0,
            total_lines: 0,
            offset: 0,
            truncated: false,
            next_offset: None,
            base_digest: Some("digest".into()),
        }
    }

    fn service_with_fake_git() -> (
        RepositoryEntry,
        Arc<FakeGit>,
        Arc<FakeIdeLauncher>,
        RepoService,
    ) {
        let repo = repo_entry();
        let seen_path = Arc::new(Mutex::new(None));
        let git = Arc::new(FakeGit {
            seen_path: seen_path.clone(),
            ..FakeGit::default()
        });
        let ide = Arc::new(FakeIdeLauncher {
            opened: Mutex::new(None),
            terminal_opened: Mutex::new(None),
        });
        let service = RepoService::new(
            Arc::new(FakeStore { repo: repo.clone() }),
            Arc::new(FakeSettingsStore {
                settings: Settings {
                    default_ide: Some("code".to_string()),
                    ..Settings::default()
                },
            }),
            git.clone(),
            Arc::new(FakeRemoteGit {
                seen_path,
                ..FakeRemoteGit::default()
            }),
            Arc::new(FakeEnvironment),
            ide.clone(),
        );
        (repo, git, ide, service)
    }

    #[async_trait]
    impl GitBackend for FakeGit {
        fn generations(&self, _repo: &RepoPath) -> Result<GenerationSet, GitError> {
            Ok(GenerationSet {
                working_tree: u64::from(
                    self.generation_changes_on_first_preflight
                        && self.working_diff_calls.load(Ordering::SeqCst) > 0,
                ),
                ..GenerationSet::default()
            })
        }

        async fn status(&self, _repo: &RepoPath) -> Result<RepoStatus, GitError> {
            Ok(RepoStatus {
                branch: Some("main".into()),
                ahead: 0,
                behind: 0,
                dirty_count: 0,
                has_conflict: false,
            })
        }
        async fn operation_state(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(RepoOperationState {
                operation: fjord_domain::RepoOperation::Normal,
                conflicted_paths: Vec::new(),
                available: Vec::new(),
                detected_externally: false,
            })
        }
        async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec![BranchInfo {
                name: "main".into(),
                is_current: true,
                is_remote: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                target_commit_id: CommitId("abc123".into()),
            }])
        }
        async fn tags(&self, repo: &RepoPath) -> Result<Vec<TagInfo>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec![TagInfo {
                name: "v1.0.0".into(),
                target_commit_id: CommitId("abc123".into()),
            }])
        }
        async fn log(
            &self,
            repo: &RepoPath,
            _from: Option<LogCursor>,
            _limit: u32,
        ) -> Result<CommitPage, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(CommitPage {
                commits: vec![CommitSummary {
                    id: CommitId("abc123".into()),
                    parent_ids: vec![],
                    message: "Add searchable commit".into(),
                    author_name: "Ada".into(),
                    author_email: "ada@example.test".into(),
                    authored_at: OffsetDateTime::from_unix_timestamp(0).unwrap(),
                    refs: vec![],
                }],
                next_cursor: None,
            })
        }
        async fn reflog(
            &self,
            repo: &RepoPath,
            _ref_name: Option<&str>,
            _from: Option<LogCursor>,
            _limit: u32,
        ) -> Result<ReflogPage, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(ReflogPage {
                entries: vec![],
                next_cursor: None,
            })
        }
        async fn reflog_refs(&self, repo: &RepoPath) -> Result<Vec<String>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec!["refs/heads/main".into()])
        }
        async fn diff_against_head(
            &self,
            repo: &RepoPath,
            _commit_id: &str,
        ) -> Result<Vec<FileDiff>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec![FileDiff {
                path: "README.md".into(),
                change_type: FileChangeType::Modified,
                additions: 1,
                deletions: 1,
            }])
        }
        async fn search_commits(
            &self,
            repo: &RepoPath,
            query: &str,
            _limit: u32,
        ) -> Result<Vec<CommitSummary>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            let message = "Add searchable commit";
            if message.to_lowercase().contains(&query.to_lowercase()) {
                Ok(vec![CommitSummary {
                    id: CommitId("abc123".into()),
                    parent_ids: vec![],
                    message: message.into(),
                    author_name: "Ada".into(),
                    author_email: "ada@example.test".into(),
                    authored_at: OffsetDateTime::from_unix_timestamp(0).unwrap(),
                    refs: vec![],
                }])
            } else {
                Ok(vec![])
            }
        }
        async fn commits_unreachable_from_head(
            &self,
            _repo: &RepoPath,
            _tip: &str,
            _sample_limit: u32,
        ) -> Result<(u32, Vec<CommitSummary>), GitError> {
            Ok((
                7,
                (0..7)
                    .map(|index| CommitSummary {
                        id: CommitId(format!("commit-{index}")),
                        parent_ids: vec![],
                        message: format!("Dropped commit {index}"),
                        author_name: "Ada".into(),
                        author_email: "ada@example.test".into(),
                        authored_at: OffsetDateTime::UNIX_EPOCH,
                        refs: vec![],
                    })
                    .collect(),
            ))
        }
        async fn destructive_action_facts(
            &self,
            _repo: &RepoPath,
            action: &DestructiveAction,
            sample_limit: u32,
        ) -> Result<DestructiveActionFacts, GitError> {
            let sample = (0..sample_limit.min(5))
                .map(|index| CommitSummary {
                    id: CommitId(format!("commit-{index}")),
                    parent_ids: vec![],
                    message: format!("Lost commit {index}"),
                    author_name: "Ada".into(),
                    author_email: "ada@example.test".into(),
                    authored_at: OffsetDateTime::UNIX_EPOCH,
                    refs: vec![],
                })
                .collect();
            Ok(DestructiveActionFacts {
                consequences: vec![Consequence::CommitsUnreachable { count: 7, sample }],
                recoverable: if matches!(
                    action,
                    DestructiveAction::Reset { .. } | DestructiveAction::RecoveryRestore { .. }
                ) {
                    Recoverability::Reflog
                } else {
                    Recoverability::NotRecoverable
                },
                blockers: Vec::new(),
            })
        }
        async fn diff(&self, repo: &RepoPath, _commit_id: &str) -> Result<Vec<FileDiff>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec![FileDiff {
                path: "src/main.rs".into(),
                change_type: FileChangeType::Modified,
                additions: 3,
                deletions: 1,
            }])
        }
        async fn file_diff(
            &self,
            repo: &RepoPath,
            _commit_id: &str,
            path: &str,
        ) -> Result<FileDiffDetail, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(FileDiffDetail {
                path: path.to_string(),
                change_type: FileChangeType::Modified,
                old_mode: Some(0o100644),
                new_mode: Some(0o100644),
                is_binary: false,
                hunks: vec![],
            })
        }
        async fn file_diff_window(
            &self,
            repo: &RepoPath,
            _commit_id: &str,
            path: &str,
            options: DiffWindowOptions,
        ) -> Result<FileDiffWindow, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            self.diff_window_options.lock().unwrap().push(options);
            Ok(fake_diff_window(path))
        }
        async fn checkout(&self, repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn checkout_overwrite_paths(
            &self,
            repo: &RepoPath,
            _branch: &str,
        ) -> Result<Vec<String>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec![])
        }
        async fn working_changes(&self, repo: &RepoPath) -> Result<WorkingChanges, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(WorkingChanges {
                staged: vec![],
                unstaged: vec![WorkingFile {
                    path: "src/main.rs".into(),
                    change_type: FileChangeType::Modified,
                    conflicted: false,
                }],
            })
        }
        async fn working_file_diff(
            &self,
            repo: &RepoPath,
            path: &str,
            _staged: bool,
        ) -> Result<FileDiffDetail, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            self.working_diff_calls.fetch_add(1, Ordering::SeqCst);
            Ok(FileDiffDetail {
                path: path.to_string(),
                change_type: FileChangeType::Modified,
                old_mode: Some(0o100644),
                new_mode: Some(0o100644),
                is_binary: false,
                hunks: vec![fjord_domain::DiffHunk {
                    old_start: 1,
                    old_lines: 2,
                    new_start: 1,
                    new_lines: 2,
                    lines: vec![
                        fjord_domain::DiffLine {
                            kind: fjord_domain::DiffLineKind::Deletion,
                            old_lineno: Some(1),
                            new_lineno: None,
                            content: "old".into(),
                            line_ending: Some(fjord_domain::DiffLineEnding::Lf),
                        },
                        fjord_domain::DiffLine {
                            kind: fjord_domain::DiffLineKind::Addition,
                            old_lineno: None,
                            new_lineno: Some(1),
                            content: "new".into(),
                            line_ending: Some(fjord_domain::DiffLineEnding::Lf),
                        },
                        fjord_domain::DiffLine {
                            kind: fjord_domain::DiffLineKind::Context,
                            old_lineno: Some(2),
                            new_lineno: Some(2),
                            content: "same".into(),
                            line_ending: Some(fjord_domain::DiffLineEnding::Lf),
                        },
                    ],
                }],
            })
        }
        async fn working_file_diff_window(
            &self,
            repo: &RepoPath,
            path: &str,
            _staged: bool,
            options: DiffWindowOptions,
        ) -> Result<FileDiffWindow, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            self.diff_window_options.lock().unwrap().push(options);
            self.working_diff_calls.fetch_add(1, Ordering::SeqCst);
            Ok(fake_diff_window(path))
        }
        async fn create_branch(
            &self,
            repo: &RepoPath,
            _name: &str,
            _checkout: bool,
        ) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn stashes(&self, repo: &RepoPath) -> Result<Vec<StashEntry>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec![StashEntry {
                index: 0,
                message: "WIP on main".into(),
            }])
        }
        async fn stash_push(
            &self,
            repo: &RepoPath,
            _message: Option<&str>,
        ) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn stash_pop(&self, repo: &RepoPath) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn stage(&self, repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn stage_patch(
            &self,
            repo: &RepoPath,
            selection: &PatchSelection,
            expected_generations: GenerationSet,
        ) -> Result<GenerationSet, GitError> {
            *self.stage_patch_call.lock().unwrap() =
                Some((repo.0.clone(), selection.clone(), expected_generations));
            Ok(GenerationSet {
                working_tree: expected_generations.working_tree + 1,
                ..expected_generations
            })
        }
        async fn unstage(&self, repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn unstage_patch(
            &self,
            repo: &RepoPath,
            selection: &PatchSelection,
            expected_generations: GenerationSet,
        ) -> Result<GenerationSet, GitError> {
            *self.unstage_patch_call.lock().unwrap() =
                Some((repo.0.clone(), selection.clone(), expected_generations));
            Ok(GenerationSet {
                working_tree: expected_generations.working_tree + 1,
                ..expected_generations
            })
        }
        async fn issue_discard_confirmation(
            &self,
            _repo: &RepoPath,
            _action: &DestructiveAction,
            _selection: &PatchSelection,
            _generations: GenerationSet,
        ) -> Result<String, GitError> {
            Ok("confirmation-token".to_string())
        }

        async fn issue_action_confirmation(
            &self,
            _repo: &RepoPath,
            _action: &DestructiveAction,
            _generations: GenerationSet,
        ) -> Result<String, GitError> {
            Ok("action-confirmation-token".to_string())
        }

        async fn consume_action_confirmation(
            &self,
            _repo: &RepoPath,
            _action: &DestructiveAction,
            _expected_generations: GenerationSet,
            _confirmation_token: &str,
        ) -> Result<(), GitError> {
            if self.reject_action_confirmation {
                Err(GitError::PreflightStale)
            } else {
                Ok(())
            }
        }

        async fn execute_confirmed_destructive_action(
            &self,
            repo: &RepoPath,
            action: &DestructiveAction,
            expected_generations: GenerationSet,
            confirmation_token: &str,
            _context: GitOperationContext,
        ) -> Result<Option<RepoOperationState>, GitError> {
            *self.destructive_action_call.lock().unwrap() = Some((
                repo.0.clone(),
                action.clone(),
                expected_generations,
                confirmation_token.to_string(),
            ));
            Ok(None)
        }

        async fn discard_patch(
            &self,
            repo: &RepoPath,
            action: &DestructiveAction,
            selection: &PatchSelection,
            expected_generations: GenerationSet,
            confirmation_token: &str,
        ) -> Result<GenerationSet, GitError> {
            *self.discard_patch_call.lock().unwrap() = Some((
                repo.0.clone(),
                action.clone(),
                selection.clone(),
                expected_generations,
                confirmation_token.to_string(),
            ));
            Ok(GenerationSet {
                working_tree: expected_generations.working_tree + 1,
                ..expected_generations
            })
        }
        async fn commit(&self, repo: &RepoPath, _message: &str) -> Result<String, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok("deadbeef".into())
        }
        async fn amend(&self, repo: &RepoPath, _message: &str) -> Result<String, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok("feedface".into())
        }
        async fn upstream_remote(&self, repo: &RepoPath) -> Result<String, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok("origin".into())
        }
        async fn integrate_upstream(&self, repo: &RepoPath) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn current_push_target(&self, repo: &RepoPath) -> Result<PushTarget, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(PushTarget {
                remote: "company".into(),
                local_ref: "refs/heads/develop".into(),
                remote_ref: "refs/heads/trunk".into(),
            })
        }
        async fn force_push_plan(&self, repo: &RepoPath) -> Result<ForcePushPlan, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(ForcePushPlan {
                remote: "company".into(),
                remote_ref: "refs/heads/trunk".into(),
                expected_oid: "deadbeef".into(),
                source_oid: "feedface".into(),
            })
        }
        async fn issue_force_push_confirmation(
            &self,
            _repo: &RepoPath,
            _action: &DestructiveAction,
            _plan: &ForcePushPlan,
            _generations: GenerationSet,
        ) -> Result<String, GitError> {
            Ok("force-confirmation-token".into())
        }
        async fn consume_force_push_confirmation(
            &self,
            _repo: &RepoPath,
            _action: &DestructiveAction,
            _expected_generations: GenerationSet,
            _confirmation_token: &str,
        ) -> Result<ForcePushPlan, GitError> {
            if self.reject_force_confirmation {
                return Err(GitError::PreflightStale);
            }
            self.force_push_plan(_repo).await
        }
        async fn current_branch_ref(&self, repo: &RepoPath) -> Result<String, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok("refs/heads/develop".into())
        }
        async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
    }

    #[tokio::test]
    async fn resolves_the_repo_id_to_a_path_before_calling_git() {
        let (repo, git, _, service) = service_with_fake_git();

        let branches = service.get_branches(repo.id).await.unwrap();
        assert_eq!(branches.len(), 1);
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn unknown_repo_id_is_reported_before_touching_git() {
        let repo = RepositoryEntry {
            id: RepositoryId::new(),
            workspace_id: WorkspaceId::new(),
            name: "api-gateway".into(),
            path: PathBuf::from("/repos/api-gateway"),
            sort_order: 0,
        };
        let git = Arc::new(FakeGit {
            seen_path: Arc::new(Mutex::new(None)),
            ..FakeGit::default()
        });
        let service = RepoService::new(
            Arc::new(FakeStore { repo }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            git,
            Arc::new(FakeRemoteGit::default()),
            Arc::new(FakeEnvironment),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
                terminal_opened: Mutex::new(None),
            }),
        );

        let result = service.get_branches(RepositoryId::new()).await;
        assert!(matches!(
            result,
            Err(RepoError::Store(StoreError::RepositoryNotFound(_)))
        ));
    }

    #[tokio::test]
    async fn get_tags_resolves_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let tags = service.get_tags(repo.id).await.unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn get_commit_log_resolves_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        service.get_commit_log(repo.id, None, 20).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn reflog_reads_resolve_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        service.get_reflog(repo.id, None, None, 20).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));
        assert_eq!(
            service.get_reflog_refs(repo.id).await.unwrap(),
            ["refs/heads/main"]
        );
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn recovery_diff_resolves_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let files = service.get_recovery_diff(repo.id, "abc123").await.unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn search_commit_log_resolves_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let commits = service
            .search_commit_log(repo.id, "searchable", 20)
            .await
            .unwrap();

        assert_eq!(commits.len(), 1);
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn global_search_matches_repositories_branches_and_commits() {
        let (repo, _, _, service) = service_with_fake_git();

        let repo_results = service.global_search(None, "gateway", 10).await.unwrap();
        assert!(
            repo_results
                .iter()
                .any(|result| result.kind == SearchResultKind::Repository
                    && result.repo_id == repo.id)
        );

        let branch_results = service.global_search(None, "main", 10).await.unwrap();
        assert!(branch_results
            .iter()
            .any(|result| result.kind == SearchResultKind::Branch
                && result.branch.as_deref() == Some("main")));

        let commit_results = service.global_search(None, "searchable", 10).await.unwrap();
        assert!(commit_results.iter().any(|result| {
            result.kind == SearchResultKind::Commit
                && result.commit.as_ref().map(|commit| commit.id.0.as_str()) == Some("abc123")
        }));
    }

    #[tokio::test]
    async fn global_search_respects_the_global_limit() {
        let (_, _, _, service) = service_with_fake_git();

        // "a" hits the repository name, the branch, and the commit message —
        // the limit must cut the merged list, not just each category.
        let results = service.global_search(None, "a", 2).await.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].kind, SearchResultKind::Repository);
    }

    #[tokio::test]
    async fn get_commit_diff_resolves_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let files = service.get_commit_diff(repo.id, "deadbeef").await.unwrap();
        let fast_files = service.get_commit_files(repo.id, "deadbeef").await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(fast_files.len(), 1);
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn get_file_diff_resolves_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let detail = service
            .get_file_diff(
                repo.id,
                "deadbeef",
                "src/main.rs",
                DiffRequestOptions {
                    offset: 0,
                    limit: 1_000,
                    whitespace: DiffWhitespaceMode::Show,
                    load_anyway: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(detail.path, "src/main.rs");
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
        assert_eq!(
            git.diff_window_options.lock().unwrap()[0].max_file_bytes,
            DIFF_FILE_MAX_BYTES
        );
    }

    #[tokio::test]
    async fn load_anyway_bypasses_only_the_source_file_ceiling() {
        let (repo, git, _, service) = service_with_fake_git();

        let detail = service
            .get_file_diff(
                repo.id,
                "deadbeef",
                "src/main.rs",
                DiffRequestOptions {
                    offset: 0,
                    limit: u32::MAX,
                    whitespace: DiffWhitespaceMode::Show,
                    load_anyway: true,
                },
            )
            .await
            .unwrap();

        assert_eq!(detail.path, "src/main.rs");
        let options = git.diff_window_options.lock().unwrap()[0];
        assert_eq!(options.max_file_bytes, u64::MAX);
        assert_eq!(options.limit, DIFF_WINDOW_MAX_LINES);
    }

    #[tokio::test]
    async fn write_operations_resolve_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        service.checkout_branch(repo.id, "main").await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        service
            .stage_files(repo.id, &[PathBuf::from("src/main.rs")])
            .await
            .unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        service
            .unstage_files(repo.id, &[PathBuf::from("src/main.rs")])
            .await
            .unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        let oid = service.commit(repo.id, "Update", false).await.unwrap();
        assert_eq!(oid, "deadbeef");
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        let amended_oid = service.commit(repo.id, "Corrected", true).await.unwrap();
        assert_eq!(amended_oid, "feedface");
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        service.fetch(repo.id, "origin").await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        service.pull(repo.id).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        service.push(repo.id).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    /// A Git chosen in Settings must drive local subprocess operations too —
    /// otherwise cherry-pick, reset, and tag silently run a different binary
    /// (or none at all, when Git is not on `PATH`) than fetch and push.
    #[tokio::test]
    async fn the_resolved_git_executable_reaches_the_local_backend() {
        #[derive(Default)]
        struct RecordingGit {
            executable: Mutex<Option<GitExecutableResolution>>,
        }

        #[async_trait]
        impl GitBackend for RecordingGit {
            async fn status(&self, _repo: &RepoPath) -> Result<RepoStatus, GitError> {
                Err(GitError::NotImplemented("status"))
            }
            async fn branches(&self, _repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
                Ok(vec![])
            }
            async fn tags(&self, _repo: &RepoPath) -> Result<Vec<TagInfo>, GitError> {
                Ok(vec![])
            }
            async fn log(
                &self,
                _repo: &RepoPath,
                _from: Option<LogCursor>,
                _limit: u32,
            ) -> Result<CommitPage, GitError> {
                Err(GitError::NotImplemented("log"))
            }
            async fn search_commits(
                &self,
                _repo: &RepoPath,
                _query: &str,
                _limit: u32,
            ) -> Result<Vec<CommitSummary>, GitError> {
                Ok(vec![])
            }
            async fn diff(
                &self,
                _repo: &RepoPath,
                _commit_id: &str,
            ) -> Result<Vec<FileDiff>, GitError> {
                Ok(vec![])
            }
            async fn file_diff(
                &self,
                _repo: &RepoPath,
                _commit_id: &str,
                _path: &str,
            ) -> Result<FileDiffDetail, GitError> {
                Err(GitError::NotImplemented("file_diff"))
            }
            async fn working_changes(&self, _repo: &RepoPath) -> Result<WorkingChanges, GitError> {
                Err(GitError::NotImplemented("working_changes"))
            }
            async fn working_file_diff(
                &self,
                _repo: &RepoPath,
                _path: &str,
                _staged: bool,
            ) -> Result<FileDiffDetail, GitError> {
                Err(GitError::NotImplemented("working_file_diff"))
            }
            async fn checkout(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
                Ok(())
            }
            async fn create_branch(
                &self,
                _repo: &RepoPath,
                _name: &str,
                _checkout: bool,
            ) -> Result<(), GitError> {
                Ok(())
            }
            async fn stashes(&self, _repo: &RepoPath) -> Result<Vec<StashEntry>, GitError> {
                Ok(vec![])
            }
            async fn stash_push(
                &self,
                _repo: &RepoPath,
                _message: Option<&str>,
            ) -> Result<(), GitError> {
                Ok(())
            }
            async fn stash_pop(&self, _repo: &RepoPath) -> Result<(), GitError> {
                Ok(())
            }
            async fn stage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
                Ok(())
            }
            async fn unstage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
                Ok(())
            }
            async fn commit(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> {
                Ok(String::new())
            }
            async fn open_merge_tool(&self, _repo: &RepoPath) -> Result<(), GitError> {
                Ok(())
            }
            fn set_git_executable(&self, resolution: GitExecutableResolution) {
                *self.executable.lock().unwrap() = Some(resolution);
            }
        }

        let git = Arc::new(RecordingGit::default());
        let service = RepoService::new(
            Arc::new(FakeStore { repo: repo_entry() }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            git.clone(),
            Arc::new(FakeRemoteGit::default()),
            Arc::new(FakeEnvironment),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
                terminal_opened: Mutex::new(None),
            }),
        );

        service.refresh_git_executable().await;
        assert_eq!(
            *git.executable.lock().unwrap(),
            Some(GitExecutableResolution::Resolved(PathBuf::from("git"))),
            "startup must apply the resolved executable"
        );

        service
            .set_git_executable_path(PathBuf::from("/opt/git/bin/git"))
            .await
            .unwrap();
        assert_eq!(
            *git.executable.lock().unwrap(),
            Some(GitExecutableResolution::Resolved(PathBuf::from("git"))),
            "the backend follows what diagnostics resolved, not the raw input"
        );
    }

    /// An environment whose configured path does not validate. Inspection
    /// succeeds — the state has to be renderable in Settings — but reports the
    /// path as invalid and resolves no executable.
    struct InvalidConfiguredEnvironment;

    #[async_trait]
    impl GitEnvironmentProvider for InvalidConfiguredEnvironment {
        async fn inspect(
            &self,
            _configured_path: Option<&Path>,
        ) -> Result<GitEnvironmentInfo, GitEnvironmentError> {
            Ok(GitEnvironmentInfo {
                executable_path: None,
                version: None,
                executable_source: None,
                configured_path_valid: false,
                credential_helpers: vec![],
                ssh_command: None,
                ssh_agent_available: false,
                proxy_configured: false,
                askpass_available: false,
            })
        }

        async fn test_connection(
            &self,
            _repo: &RepoPath,
            _remote: &str,
            _context: GitOperationContext,
        ) -> Result<GitConnectionTestResult, GitRemoteError> {
            Err(GitRemoteError::GitExecutableNotFound)
        }
    }

    /// P5-20. The old behavior applied `None` here, which the local backend read
    /// as "look up `git` on PATH" — so a bad setting left local operations on a
    /// different Git than remote transport, which failed outright. Both sides
    /// must now reach the same conclusion.
    #[tokio::test]
    async fn an_invalid_configured_executable_never_falls_back_to_path() {
        #[derive(Default)]
        struct RecordingGit {
            executable: Mutex<Option<GitExecutableResolution>>,
        }

        #[async_trait]
        impl GitBackend for RecordingGit {
            async fn status(&self, _repo: &RepoPath) -> Result<RepoStatus, GitError> {
                Err(GitError::NotImplemented("status"))
            }
            async fn branches(&self, _repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
                Ok(vec![])
            }
            async fn tags(&self, _repo: &RepoPath) -> Result<Vec<TagInfo>, GitError> {
                Ok(vec![])
            }
            async fn log(
                &self,
                _repo: &RepoPath,
                _from: Option<LogCursor>,
                _limit: u32,
            ) -> Result<CommitPage, GitError> {
                Err(GitError::NotImplemented("log"))
            }
            async fn search_commits(
                &self,
                _repo: &RepoPath,
                _query: &str,
                _limit: u32,
            ) -> Result<Vec<CommitSummary>, GitError> {
                Ok(vec![])
            }
            async fn diff(
                &self,
                _repo: &RepoPath,
                _commit_id: &str,
            ) -> Result<Vec<FileDiff>, GitError> {
                Err(GitError::NotImplemented("diff"))
            }
            async fn file_diff(
                &self,
                _repo: &RepoPath,
                _commit_id: &str,
                _path: &str,
            ) -> Result<FileDiffDetail, GitError> {
                Err(GitError::NotImplemented("file_diff"))
            }
            async fn working_changes(&self, _repo: &RepoPath) -> Result<WorkingChanges, GitError> {
                Err(GitError::NotImplemented("working_changes"))
            }
            async fn working_file_diff(
                &self,
                _repo: &RepoPath,
                _path: &str,
                _staged: bool,
            ) -> Result<FileDiffDetail, GitError> {
                Err(GitError::NotImplemented("working_file_diff"))
            }
            async fn checkout(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
                Ok(())
            }
            async fn create_branch(
                &self,
                _repo: &RepoPath,
                _name: &str,
                _checkout: bool,
            ) -> Result<(), GitError> {
                Ok(())
            }
            async fn stashes(&self, _repo: &RepoPath) -> Result<Vec<StashEntry>, GitError> {
                Ok(vec![])
            }
            async fn stash_push(
                &self,
                _repo: &RepoPath,
                _message: Option<&str>,
            ) -> Result<(), GitError> {
                Ok(())
            }
            async fn stash_pop(&self, _repo: &RepoPath) -> Result<(), GitError> {
                Ok(())
            }
            async fn stage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
                Ok(())
            }
            async fn unstage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
                Ok(())
            }
            async fn commit(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> {
                Ok(String::new())
            }
            async fn open_merge_tool(&self, _repo: &RepoPath) -> Result<(), GitError> {
                Ok(())
            }
            fn set_git_executable(&self, resolution: GitExecutableResolution) {
                *self.executable.lock().unwrap() = Some(resolution);
            }
        }

        let git = Arc::new(RecordingGit::default());
        let service = RepoService::new(
            Arc::new(FakeStore { repo: repo_entry() }),
            Arc::new(FakeSettingsStore {
                settings: Settings {
                    git_executable_path: Some(PathBuf::from("/nowhere/git")),
                    ..Settings::default()
                },
            }),
            git.clone(),
            Arc::new(FakeRemoteGit::default()),
            Arc::new(InvalidConfiguredEnvironment),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
                terminal_opened: Mutex::new(None),
            }),
        );

        service.refresh_git_executable().await;
        assert_eq!(
            *git.executable.lock().unwrap(),
            Some(GitExecutableResolution::Unavailable),
            "an invalid configured path must not leave local commands on PATH git"
        );

        // Local and remote must classify the same setting the same way.
        let local_code = app_code(&GitError::ExecutableNotFound);
        let remote_code = GitRemoteError::GitExecutableNotFound.code();
        assert_eq!(local_code, remote_code);

        // And choosing that path in Settings must be refused, not stored.
        let error = service
            .set_git_executable_path(PathBuf::from("/nowhere/git"))
            .await
            .expect_err("an invalid path must not be persisted");
        assert!(matches!(
            error,
            RepoError::Environment(GitEnvironmentError::InvalidConfiguredPath)
        ));
    }

    /// Mirrors the mapping in `fjord-app`'s error boundary. Kept here so the
    /// services crate can assert the shared classification without depending on
    /// the Tauri layer.
    fn app_code(error: &GitError) -> &'static str {
        match error {
            GitError::ExecutableNotFound => "git_executable_not_found",
            _ => "git_error",
        }
    }

    /// A branch tracking `company/trunk` must not be pushed to `origin/develop`
    /// just because the local branch is called `develop`.
    #[tokio::test]
    async fn push_targets_the_configured_upstream_and_publish_names_its_remote() {
        let repo = repo_entry();
        let remote = Arc::new(FakeRemoteGit::default());
        let service = RepoService::new(
            Arc::new(FakeStore { repo: repo.clone() }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            Arc::new(FakeGit {
                seen_path: Arc::new(Mutex::new(None)),
                ..FakeGit::default()
            }),
            remote.clone(),
            Arc::new(FakeEnvironment),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
                terminal_opened: Mutex::new(None),
            }),
        );

        service.push(repo.id).await.unwrap();
        assert_eq!(
            remote.pushes.lock().unwrap().as_slice(),
            [(
                "company".to_string(),
                vec!["refs/heads/develop:refs/heads/trunk".to_string()]
            )]
        );

        service.publish_branch(repo.id, None).await.unwrap();
        service
            .publish_branch(repo.id, Some("company"))
            .await
            .unwrap();
        assert_eq!(
            remote.publishes.lock().unwrap().as_slice(),
            [
                ("origin".to_string(), "refs/heads/develop".to_string()),
                ("company".to_string(), "refs/heads/develop".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn push_without_an_upstream_reports_no_upstream_instead_of_guessing() {
        struct NoUpstreamGit;

        #[async_trait]
        impl GitBackend for NoUpstreamGit {
            async fn status(&self, _repo: &RepoPath) -> Result<RepoStatus, GitError> {
                Err(GitError::NotImplemented("status"))
            }
            async fn branches(&self, _repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
                Ok(vec![])
            }
            async fn tags(&self, _repo: &RepoPath) -> Result<Vec<TagInfo>, GitError> {
                Ok(vec![])
            }
            async fn log(
                &self,
                _repo: &RepoPath,
                _from: Option<LogCursor>,
                _limit: u32,
            ) -> Result<CommitPage, GitError> {
                Err(GitError::NotImplemented("log"))
            }
            async fn search_commits(
                &self,
                _repo: &RepoPath,
                _query: &str,
                _limit: u32,
            ) -> Result<Vec<CommitSummary>, GitError> {
                Ok(vec![])
            }
            async fn diff(
                &self,
                _repo: &RepoPath,
                _commit_id: &str,
            ) -> Result<Vec<FileDiff>, GitError> {
                Ok(vec![])
            }
            async fn file_diff(
                &self,
                _repo: &RepoPath,
                _commit_id: &str,
                _path: &str,
            ) -> Result<FileDiffDetail, GitError> {
                Err(GitError::NotImplemented("file_diff"))
            }
            async fn working_changes(&self, _repo: &RepoPath) -> Result<WorkingChanges, GitError> {
                Err(GitError::NotImplemented("working_changes"))
            }
            async fn working_file_diff(
                &self,
                _repo: &RepoPath,
                _path: &str,
                _staged: bool,
            ) -> Result<FileDiffDetail, GitError> {
                Err(GitError::NotImplemented("working_file_diff"))
            }
            async fn checkout(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
                Ok(())
            }
            async fn create_branch(
                &self,
                _repo: &RepoPath,
                _name: &str,
                _checkout: bool,
            ) -> Result<(), GitError> {
                Ok(())
            }
            async fn stashes(&self, _repo: &RepoPath) -> Result<Vec<StashEntry>, GitError> {
                Ok(vec![])
            }
            async fn stash_push(
                &self,
                _repo: &RepoPath,
                _message: Option<&str>,
            ) -> Result<(), GitError> {
                Ok(())
            }
            async fn stash_pop(&self, _repo: &RepoPath) -> Result<(), GitError> {
                Ok(())
            }
            async fn stage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
                Ok(())
            }
            async fn unstage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
                Ok(())
            }
            async fn commit(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> {
                Ok(String::new())
            }
            async fn current_push_target(&self, _repo: &RepoPath) -> Result<PushTarget, GitError> {
                Err(GitError::NoUpstream)
            }
            async fn open_merge_tool(&self, _repo: &RepoPath) -> Result<(), GitError> {
                Ok(())
            }
        }

        let repo = repo_entry();
        let remote = Arc::new(FakeRemoteGit::default());
        let service = RepoService::new(
            Arc::new(FakeStore { repo: repo.clone() }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            Arc::new(NoUpstreamGit),
            remote.clone(),
            Arc::new(FakeEnvironment),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
                terminal_opened: Mutex::new(None),
            }),
        );

        let error = service.push(repo.id).await.unwrap_err();
        assert!(matches!(error, RepoError::Git(GitError::NoUpstream)));
        assert!(remote.pushes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn working_changes_and_working_file_diff_resolve_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let changes = service.get_working_changes(repo.id).await.unwrap();
        assert_eq!(changes.unstaged.len(), 1);
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        let detail = service
            .get_working_file_diff(
                repo.id,
                "src/main.rs",
                false,
                DiffRequestOptions {
                    offset: 0,
                    limit: 1_000,
                    whitespace: DiffWhitespaceMode::Show,
                    load_anyway: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(detail.path, "src/main.rs");
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn stage_patch_forwards_selection_and_expected_generation_and_returns_the_result() {
        let (repo, git, _, service) = service_with_fake_git();
        let selection = PatchSelection {
            path: "src/main.rs".into(),
            source: fjord_domain::PatchSource::Worktree,
            hunks: vec![fjord_domain::HunkSelection {
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: Vec::new(),
            }],
            base_digest: "digest".into(),
        };
        let expected = GenerationSet {
            working_tree: 7,
            refs: 2,
            ..GenerationSet::default()
        };

        let result = service
            .stage_patch(repo.id, &selection, expected)
            .await
            .unwrap();

        assert_eq!(result.working_tree, 8);
        assert_eq!(result.refs, 2);
        assert_eq!(
            *git.stage_patch_call.lock().unwrap(),
            Some((repo.path, selection, expected))
        );
    }

    #[tokio::test]
    async fn unstage_patch_forwards_index_selection_and_expected_generation() {
        let (repo, git, _, service) = service_with_fake_git();
        let selection = PatchSelection {
            path: "src/main.rs".into(),
            source: fjord_domain::PatchSource::Index,
            hunks: vec![fjord_domain::HunkSelection {
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: Vec::new(),
            }],
            base_digest: "digest".into(),
        };
        let expected = GenerationSet {
            working_tree: 7,
            refs: 2,
            ..GenerationSet::default()
        };

        let result = service
            .unstage_patch(repo.id, &selection, expected)
            .await
            .unwrap();

        assert_eq!(result.working_tree, 8);
        assert_eq!(result.refs, 2);
        assert_eq!(
            *git.unstage_patch_call.lock().unwrap(),
            Some((repo.path, selection, expected))
        );
    }

    #[tokio::test]
    async fn discard_patch_forwards_confirmed_worktree_selection_and_generation() {
        let (repo, git, _, service) = service_with_fake_git();
        let selection = PatchSelection {
            path: "src/main.rs".into(),
            source: fjord_domain::PatchSource::Worktree,
            hunks: vec![fjord_domain::HunkSelection {
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: vec![0],
            }],
            base_digest: "digest".into(),
        };
        let expected = GenerationSet {
            working_tree: 7,
            refs: 2,
            ..GenerationSet::default()
        };
        let action = DestructiveAction::Discard {
            selection: DiscardSelection::Lines {
                path: "src/main.rs".into(),
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: vec![0],
            },
        };

        let result = service
            .discard_patch(repo.id, &action, &selection, expected, "confirmation-token")
            .await
            .unwrap();

        assert_eq!(result.working_tree, 8);
        assert_eq!(result.refs, 2);
        assert_eq!(
            *git.discard_patch_call.lock().unwrap(),
            Some((
                repo.path,
                action,
                selection,
                expected,
                "confirmation-token".to_string(),
            ))
        );
    }

    #[tokio::test]
    async fn working_patch_diff_retries_until_its_generation_is_coherent() {
        let repo = repo_entry();
        let git = Arc::new(FakeGit {
            seen_path: Arc::new(Mutex::new(None)),
            generation_changes_on_first_preflight: true,
            ..FakeGit::default()
        });
        let service = RepoService::new(
            Arc::new(FakeStore { repo: repo.clone() }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            git.clone(),
            Arc::new(FakeRemoteGit::default()),
            Arc::new(FakeEnvironment),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
                terminal_opened: Mutex::new(None),
            }),
        );

        let (diff, generations) = service
            .get_working_file_diff_versioned(
                repo.id,
                "src/main.rs",
                false,
                DiffRequestOptions {
                    offset: 0,
                    limit: 1_000,
                    whitespace: DiffWhitespaceMode::Show,
                    load_anyway: false,
                },
            )
            .await
            .unwrap();

        assert_eq!(diff.path, "src/main.rs");
        assert_eq!(git.working_diff_calls.load(Ordering::SeqCst), 2);
        assert_eq!(generations.working_tree, 1);
    }

    #[tokio::test]
    async fn destructive_preflight_computes_discard_lines_and_bounds_commit_samples() {
        let (repo, _, _, service) = service_with_fake_git();

        let discard = service
            .preflight_destructive_action(
                repo.id,
                DestructiveAction::Discard {
                    selection: DiscardSelection::File {
                        path: "src/main.rs".into(),
                    },
                },
                Some(fake_worktree_selection(Vec::new())),
            )
            .await
            .unwrap();
        assert_eq!(discard.blockers, Vec::<String>::new());
        assert_eq!(
            discard.confirmation_token.as_deref(),
            Some("confirmation-token")
        );
        assert!(discard
            .consequences
            .contains(&Consequence::ModifiedFilesDiscarded {
                count: 1,
                sample: vec!["src/main.rs".into()],
            }));
        assert!(discard
            .consequences
            .contains(&Consequence::ModifiedLinesDiscarded {
                path: "src/main.rs".into(),
                count: 2,
            }));
        assert_eq!(discard.recoverable, Recoverability::NotRecoverable);

        let force = service
            .preflight_destructive_action(repo.id, DestructiveAction::ForceWithLease, None)
            .await
            .unwrap();
        let sample = force
            .consequences
            .iter()
            .find_map(|consequence| match consequence {
                Consequence::CommitsUnreachable { count, sample } => Some((*count, sample)),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            force.confirmation_token.as_deref(),
            Some("force-confirmation-token")
        );
        assert_eq!(force.recoverable, Recoverability::NotRecoverable);
        assert_eq!(force.force_with_lease.as_ref().unwrap().remote, "company");
        assert_eq!(
            force.force_with_lease.as_ref().unwrap().ref_name,
            "refs/heads/trunk"
        );
        assert_eq!(sample.0, 7);
        assert_eq!(sample.1.len(), PREFLIGHT_SAMPLE_LIMIT);
    }

    #[tokio::test]
    async fn phase_nine_preflight_routes_backend_facts_and_issues_action_confirmation() {
        let (repo, _, _, service) = service_with_fake_git();
        let action = DestructiveAction::RecoveryRestore {
            commit_id: "target".into(),
        };

        let preflight = service
            .preflight_destructive_action(repo.id, action.clone(), None)
            .await
            .unwrap();

        assert_eq!(preflight.action, action);
        assert_eq!(preflight.recoverable, Recoverability::Reflog);
        assert_eq!(
            preflight.confirmation_token.as_deref(),
            Some("action-confirmation-token")
        );
        assert!(preflight.consequences.iter().any(|consequence| matches!(
            consequence,
            Consequence::CommitsUnreachable { count: 7, sample }
                if sample.len() == PREFLIGHT_SAMPLE_LIMIT
        )));
    }

    #[tokio::test]
    async fn confirmed_destructive_execution_forwards_the_exact_backend_binding() {
        let (repo, git, _, service) = service_with_fake_git();
        let action = DestructiveAction::Reset {
            commit_id: "target".into(),
            mode: fjord_domain::ResetMode::Hard,
        };
        let generations = GenerationSet {
            working_tree: 3,
            refs: 2,
            history: 1,
            stash: 0,
            config: 0,
        };

        service
            .execute_destructive_action(
                repo.id,
                &action,
                generations,
                "bound-token",
                GitOperationContext::default(),
            )
            .await
            .unwrap();

        assert_eq!(
            git.destructive_action_call.lock().unwrap().as_ref(),
            Some(&(repo.path, action, generations, "bound-token".to_string(),))
        );
    }

    #[tokio::test]
    async fn safety_regression_remote_mutations_never_run_without_backend_confirmation() {
        let repo = repo_entry();
        let seen_path = Arc::new(Mutex::new(None));
        let git = Arc::new(FakeGit {
            seen_path: seen_path.clone(),
            reject_action_confirmation: true,
            reject_force_confirmation: true,
            ..FakeGit::default()
        });
        let remote = Arc::new(FakeRemoteGit {
            seen_path,
            ..FakeRemoteGit::default()
        });
        let service = RepoService::new(
            Arc::new(FakeStore { repo: repo.clone() }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            git,
            remote.clone(),
            Arc::new(FakeEnvironment),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
                terminal_opened: Mutex::new(None),
            }),
        );
        let generations = GenerationSet::default();
        let delete = DestructiveAction::DeleteRemoteBranch {
            remote: "origin".into(),
            branch: "topic".into(),
        };

        assert!(matches!(
            service
                .execute_destructive_action(
                    repo.id,
                    &delete,
                    generations,
                    "not-issued-by-preflight",
                    GitOperationContext::default(),
                )
                .await,
            Err(RepoError::Git(GitError::PreflightStale))
        ));
        assert!(remote.deletes.lock().unwrap().is_empty());

        assert!(matches!(
            service
                .force_push_with_context(
                    repo.id,
                    generations,
                    "not-issued-by-preflight",
                    GitOperationContext::default(),
                )
                .await,
            Err(RepoError::Git(GitError::PreflightStale))
        ));
        assert!(remote.pushes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn discard_preflight_counts_selected_changed_lines_and_blocks_stale_coordinates() {
        let (repo, _, _, service) = service_with_fake_git();
        let selected = service
            .preflight_destructive_action(
                repo.id,
                DestructiveAction::Discard {
                    selection: DiscardSelection::Lines {
                        path: "src/main.rs".into(),
                        old_start: 1,
                        old_lines: 2,
                        new_start: 1,
                        new_lines: 2,
                        lines: vec![0, 0, 2],
                    },
                },
                Some(fake_worktree_selection(vec![0, 0, 2])),
            )
            .await
            .unwrap();
        assert_eq!(
            selected.consequences,
            vec![Consequence::ModifiedLinesDiscarded {
                path: "src/main.rs".into(),
                count: 1,
            }]
        );

        let stale = service
            .preflight_destructive_action(
                repo.id,
                DestructiveAction::Discard {
                    selection: DiscardSelection::Hunk {
                        path: "src/main.rs".into(),
                        old_start: 99,
                        old_lines: 1,
                        new_start: 99,
                        new_lines: 1,
                    },
                },
                Some(fake_worktree_selection(Vec::new())),
            )
            .await
            .unwrap();
        assert_eq!(stale.blockers, ["selection_changed"]);
        assert_eq!(stale.confirmation_token, None);
        assert!(stale.consequences.is_empty());
    }

    #[tokio::test]
    async fn generation_change_discards_and_recomputes_preflight_facts() {
        let repo = repo_entry();
        let git = Arc::new(FakeGit {
            seen_path: Arc::new(Mutex::new(None)),
            generation_changes_on_first_preflight: true,
            ..FakeGit::default()
        });
        let service = RepoService::new(
            Arc::new(FakeStore { repo: repo.clone() }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            git.clone(),
            Arc::new(FakeRemoteGit::default()),
            Arc::new(FakeEnvironment),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
                terminal_opened: Mutex::new(None),
            }),
        );

        let result = service
            .preflight_destructive_action(
                repo.id,
                DestructiveAction::Discard {
                    selection: DiscardSelection::File {
                        path: "src/main.rs".into(),
                    },
                },
                Some(fake_worktree_selection(Vec::new())),
            )
            .await
            .unwrap();

        assert_eq!(git.working_diff_calls.load(Ordering::SeqCst), 2);
        assert_eq!(result.generations.working_tree, 1);
    }

    #[tokio::test]
    async fn branch_and_stash_operations_resolve_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        service
            .create_branch(repo.id, "feature/x", true)
            .await
            .unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        let stashes = service.get_stashes(repo.id).await.unwrap();
        assert_eq!(stashes.len(), 1);

        service.stash_push(repo.id, Some("wip")).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn open_terminal_resolves_the_repo_path() {
        let (repo, _, ide, service) = service_with_fake_git();

        service.open_terminal(repo.id).await.unwrap();

        assert_eq!(*ide.terminal_opened.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn status_and_merge_tool_resolve_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let status = service.get_status(repo.id).await.unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));

        let operation_state = service.get_operation_state(repo.id).await.unwrap();
        assert_eq!(
            operation_state.operation,
            fjord_domain::RepoOperation::Normal
        );

        service.open_merge_tool(repo.id).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn open_in_ide_resolves_repo_and_uses_configured_default() {
        let (repo, _, ide, service) = service_with_fake_git();

        service.open_in_ide(repo.id, None).await.unwrap();

        assert_eq!(
            *ide.opened.lock().unwrap(),
            Some((repo.path, Some("code".to_string())))
        );
    }

    #[tokio::test]
    async fn open_in_ide_override_wins_over_configured_default() {
        let (repo, _, ide, service) = service_with_fake_git();

        service.open_in_ide(repo.id, Some("cursor")).await.unwrap();

        assert_eq!(
            *ide.opened.lock().unwrap(),
            Some((repo.path, Some("cursor".to_string())))
        );
    }

    #[tokio::test]
    async fn bulk_fetch_runs_against_workspace_repositories() {
        let (repo, git, _, service) = service_with_fake_git();

        let results = service.bulk_fetch(repo.workspace_id).await.unwrap();

        assert_eq!(
            results,
            vec![BulkRepoResult {
                repo_id: repo.id,
                ok: true,
                error: None,
            }]
        );
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn bulk_open_in_ide_uses_configured_default() {
        let (repo, _, ide, service) = service_with_fake_git();

        let results = service
            .bulk_open_in_ide(repo.workspace_id, None)
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].ok);
        assert_eq!(
            *ide.opened.lock().unwrap(),
            Some((repo.path, Some("code".to_string())))
        );
    }
}
