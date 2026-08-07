use std::sync::Arc;

use fjord_domain::{
    BranchInfo, BulkRepoResult, CommitPage, CommitSummary, FileDiff, FileDiffDetail,
    GlobalSearchResult, LogCursor, RepoStatus, RepositoryEntry, RepositoryId, SearchResultKind,
    StashEntry, TagInfo, WorkingChanges, WorkspaceId,
};
use fjord_ports::{
    GitBackend, GitError, GitOperationContext, GitRemoteBackend, GitRemoteError, IdeLauncher,
    LaunchError, RepoPath, SettingsStore, StoreError, WorkspaceStore,
};
use std::path::PathBuf;
use thiserror::Error;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

const BULK_WORKER_LIMIT: usize = 6;
const SEARCH_COMMIT_SCAN_LIMIT: u32 = 80;

#[derive(Debug, Error)]
pub enum RepoError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Remote(#[from] GitRemoteError),
    #[error(transparent)]
    Launch(#[from] LaunchError),
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
    ide: Arc<dyn IdeLauncher>,
}

impl RepoService {
    pub fn new(
        workspaces: Arc<dyn WorkspaceStore>,
        settings: Arc<dyn SettingsStore>,
        git: Arc<dyn GitBackend>,
        remote: Arc<dyn GitRemoteBackend>,
        ide: Arc<dyn IdeLauncher>,
    ) -> Self {
        Self {
            workspaces,
            settings,
            git,
            remote,
            ide,
        }
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
    ) -> Result<FileDiffDetail, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .file_diff(&RepoPath::new(repo.path), commit_id, path)
            .await?)
    }

    pub async fn checkout_branch(
        &self,
        repo_id: RepositoryId,
        branch: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.checkout(&RepoPath::new(repo.path), branch).await?)
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
    ) -> Result<FileDiffDetail, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .working_file_diff(&RepoPath::new(repo.path), path, staged)
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

    pub async fn delete_branch(&self, repo_id: RepositoryId, name: &str) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .delete_branch(&RepoPath::new(repo.path), name)
            .await?)
    }

    pub async fn delete_remote_branch(
        &self,
        repo_id: RepositoryId,
        name: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .delete_remote_branch(&RepoPath::new(repo.path), name)
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

    pub async fn delete_tag(&self, repo_id: RepositoryId, name: &str) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.delete_tag(&RepoPath::new(repo.path), name).await?)
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

    pub async fn reset(
        &self,
        repo_id: RepositoryId,
        commit_id: &str,
        mode: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .reset(&RepoPath::new(repo.path), commit_id, mode)
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

    pub async fn stash_pop(&self, repo_id: RepositoryId) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.stash_pop(&RepoPath::new(repo.path)).await?)
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

    pub async fn unstage_files(
        &self,
        repo_id: RepositoryId,
        paths: &[PathBuf],
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.unstage(&RepoPath::new(repo.path), paths).await?)
    }

    pub async fn commit(&self, repo_id: RepositoryId, message: &str) -> Result<String, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.commit(&RepoPath::new(repo.path), message).await?)
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
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.pull(&RepoPath::new(repo.path)).await?)
    }

    pub async fn pull_with_context(
        &self,
        repo_id: RepositoryId,
        context: GitOperationContext,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .pull_with_context(&RepoPath::new(repo.path), context)
            .await?)
    }

    pub async fn push(&self, repo_id: RepositoryId) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.push(&RepoPath::new(repo.path), "").await?)
    }

    pub async fn push_with_context(
        &self,
        repo_id: RepositoryId,
        context: GitOperationContext,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self
            .git
            .push_with_context(&RepoPath::new(repo.path), "", context)
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
        Ok(run_bulk(repos, {
            let git = self.git.clone();
            move |repo| {
                let git = git.clone();
                async move {
                    git.pull(&RepoPath::new(repo.path))
                        .await
                        .map_err(|e| e.to_string())
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
        CommitId, CommitPage, CommitSummary, FileChangeType, FileDiff, FileDiffDetail, LogCursor,
        RepoStatus, RepoStatusSummary, RepositoryEntry, Settings, StashEntry, TagInfo,
        WorkingChanges, WorkingFile, Workspace, WorkspaceId,
    };
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use time::OffsetDateTime;

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

    struct FakeGit {
        seen_path: Arc<Mutex<Option<PathBuf>>>,
    }

    struct FakeRemoteGit {
        seen_path: Arc<Mutex<Option<PathBuf>>>,
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
            _repo: &RepoPath,
            _remote: &str,
            _refspecs: &[String],
            _context: GitOperationContext,
        ) -> Result<(), GitRemoteError> {
            Ok(())
        }

        async fn delete_remote_branch(
            &self,
            _repo: &RepoPath,
            _remote: &str,
            _branch: &str,
            _context: GitOperationContext,
        ) -> Result<(), GitRemoteError> {
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
            Arc::new(FakeRemoteGit { seen_path }),
            ide.clone(),
        );
        (repo, git, ide, service)
    }

    #[async_trait]
    impl GitBackend for FakeGit {
        async fn status(&self, _repo: &RepoPath) -> Result<RepoStatus, GitError> {
            Ok(RepoStatus {
                branch: Some("main".into()),
                ahead: 0,
                behind: 0,
                dirty_count: 0,
                has_conflict: false,
            })
        }
        async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec![BranchInfo {
                name: "main".into(),
                is_current: true,
                is_remote: false,
                upstream: None,
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
                is_binary: false,
                hunks: vec![],
            })
        }
        async fn checkout(&self, repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
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
            Ok(FileDiffDetail {
                path: path.to_string(),
                change_type: FileChangeType::Modified,
                is_binary: false,
                hunks: vec![],
            })
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
        async fn unstage(&self, repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn commit(&self, repo: &RepoPath, _message: &str) -> Result<String, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok("deadbeef".into())
        }
        async fn fetch(&self, repo: &RepoPath, _remote: &str) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn pull(&self, repo: &RepoPath) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
        }
        async fn push(&self, repo: &RepoPath, _refspec: &str) -> Result<(), GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(())
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
        });
        let service = RepoService::new(
            Arc::new(FakeStore { repo }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            git,
            Arc::new(FakeRemoteGit {
                seen_path: Arc::new(Mutex::new(None)),
            }),
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
            .get_file_diff(repo.id, "deadbeef", "src/main.rs")
            .await
            .unwrap();
        assert_eq!(detail.path, "src/main.rs");
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
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

        let oid = service.commit(repo.id, "Update").await.unwrap();
        assert_eq!(oid, "deadbeef");
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        service.fetch(repo.id, "origin").await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        service.pull(repo.id).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        service.push(repo.id).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn working_changes_and_working_file_diff_resolve_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let changes = service.get_working_changes(repo.id).await.unwrap();
        assert_eq!(changes.unstaged.len(), 1);
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path.clone()));

        let detail = service
            .get_working_file_diff(repo.id, "src/main.rs", false)
            .await
            .unwrap();
        assert_eq!(detail.path, "src/main.rs");
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
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

        service.stash_pop(repo.id).await.unwrap();
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
