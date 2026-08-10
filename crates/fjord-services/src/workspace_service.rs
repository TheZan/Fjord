use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use fjord_domain::{RepoStatusSummary, RepositoryEntry, RepositoryId, Workspace, WorkspaceId};
use fjord_ports::{GitBackend, GitError, RepoPath, StoreError, WorkspaceStore};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("not a git repository: {0}")]
    NotAGitRepository(PathBuf),
    #[error("repository is already in this workspace: {0}")]
    RepositoryAlreadyAdded(PathBuf),
    #[error(transparent)]
    Git(GitError),
}

impl From<GitError> for WorkspaceError {
    fn from(err: GitError) -> Self {
        match err {
            GitError::NotAGitRepository(path) | GitError::RepoNotFound(path) => {
                WorkspaceError::NotAGitRepository(path)
            }
            other => WorkspaceError::Git(other),
        }
    }
}

/// Workspace/repository management use-cases. Depends on `WorkspaceStore`
/// for persistence and `GitBackend` for the one thing persistence alone
/// can't tell you: whether a path is actually a Git repository before we
/// let the user add it (docs/specs/ipc-commands.md, `add_repository`).
pub struct WorkspaceService {
    store: Arc<dyn WorkspaceStore>,
    git: Arc<dyn GitBackend>,
    runtime: tokio::runtime::Handle,
    status_refreshes: Arc<Mutex<HashMap<RepositoryId, PendingStatusRefresh>>>,
}

#[derive(Debug, Default)]
struct PendingStatusRefresh {
    pending: bool,
    invalidate: bool,
}

impl WorkspaceService {
    pub fn new(store: Arc<dyn WorkspaceStore>, git: Arc<dyn GitBackend>) -> Self {
        Self {
            store,
            git,
            runtime: tokio::runtime::Handle::current(),
            status_refreshes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn list_workspaces(&self) -> Result<Vec<Workspace>, WorkspaceError> {
        Ok(self.store.list_workspaces().await?)
    }

    pub async fn create_workspace(&self, name: &str) -> Result<Workspace, WorkspaceError> {
        Ok(self.store.create_workspace(name).await?)
    }

    pub async fn rename_workspace(
        &self,
        id: WorkspaceId,
        name: &str,
    ) -> Result<Workspace, WorkspaceError> {
        Ok(self.store.rename_workspace(id, name).await?)
    }

    pub async fn reorder_workspaces(&self, ids: &[WorkspaceId]) -> Result<(), WorkspaceError> {
        Ok(self.store.reorder_workspaces(ids).await?)
    }

    pub async fn delete_workspace(&self, id: WorkspaceId) -> Result<(), WorkspaceError> {
        Ok(self.store.delete_workspace(id).await?)
    }

    pub async fn list_repositories(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<RepositoryEntry>, WorkspaceError> {
        Ok(self.store.list_repositories(workspace_id).await?)
    }

    pub async fn list_all_repositories(&self) -> Result<Vec<RepositoryEntry>, WorkspaceError> {
        Ok(self.store.list_all_repositories().await?)
    }

    pub async fn get_workspace_status(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<RepoStatusSummary>, WorkspaceError> {
        let cached = self.store.list_workspace_status(workspace_id).await?;
        let repos = self.store.list_repositories(workspace_id).await?;

        for repo in repos {
            self.schedule_repo_status_refresh(repo.id, false);
        }

        Ok(cached)
    }

    pub async fn refresh_repo_status(
        &self,
        repo_id: RepositoryId,
    ) -> Result<RepoStatusSummary, WorkspaceError> {
        refresh_repo_status_once(self.store.as_ref(), self.git.as_ref(), repo_id).await
    }

    pub async fn invalidate_repo_status(
        &self,
        repo_id: RepositoryId,
    ) -> Result<(), WorkspaceError> {
        Ok(self.store.invalidate_repo_status(repo_id).await?)
    }

    pub fn schedule_repo_status_refresh(&self, repo_id: RepositoryId, invalidate_first: bool) {
        let mut refreshes = self.status_refreshes.lock().unwrap();
        if let Some(refresh) = refreshes.get_mut(&repo_id) {
            refresh.pending = true;
            refresh.invalidate |= invalidate_first;
            return;
        }

        refreshes.insert(repo_id, PendingStatusRefresh::default());
        spawn_status_refresh_worker(
            self.runtime.clone(),
            self.status_refreshes.clone(),
            self.store.clone(),
            self.git.clone(),
            repo_id,
            invalidate_first,
        );
    }

    /// Validates `path` is a real Git repository (via `GitBackend::status`,
    /// which is the cheapest call that requires a valid repo) before
    /// persisting it — the store itself has no way to know the difference
    /// between a Git repo and an arbitrary folder.
    pub async fn add_repository(
        &self,
        workspace_id: WorkspaceId,
        path: PathBuf,
    ) -> Result<RepositoryEntry, WorkspaceError> {
        let path = fjord_fs::canonicalize_path(&path).unwrap_or(path);
        let repositories = self.store.list_repositories(workspace_id).await?;
        if repositories.iter().any(|repository| {
            let existing = fjord_fs::canonicalize_path(&repository.path)
                .unwrap_or_else(|_| repository.path.clone());
            fjord_fs::paths_equal(&existing, &path)
        }) {
            return Err(WorkspaceError::RepositoryAlreadyAdded(path));
        }

        self.git.status(&RepoPath::new(path.clone())).await?;

        let name = repo_display_name(&path);
        match self.store.add_repository(workspace_id, &name, &path).await {
            Ok(repository) => Ok(repository),
            Err(StoreError::RepositoryAlreadyExists(_)) => {
                Err(WorkspaceError::RepositoryAlreadyAdded(path))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn remove_repository(&self, id: RepositoryId) -> Result<(), WorkspaceError> {
        Ok(self.store.remove_repository(id).await?)
    }
}

fn repo_display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn spawn_status_refresh_worker(
    runtime: tokio::runtime::Handle,
    refreshes: Arc<Mutex<HashMap<RepositoryId, PendingStatusRefresh>>>,
    store: Arc<dyn WorkspaceStore>,
    git: Arc<dyn GitBackend>,
    repo_id: RepositoryId,
    invalidate_first: bool,
) {
    runtime.spawn(async move {
        let mut invalidate = invalidate_first;

        loop {
            if invalidate {
                let _ = store.invalidate_repo_status(repo_id).await;
            }

            let _ = refresh_repo_status_once(store.as_ref(), git.as_ref(), repo_id).await;

            invalidate = {
                let mut refreshes = refreshes.lock().unwrap();
                let Some(refresh) = refreshes.get_mut(&repo_id) else {
                    return;
                };

                if refresh.pending {
                    refresh.pending = false;
                    let invalidate = refresh.invalidate;
                    refresh.invalidate = false;
                    invalidate
                } else {
                    refreshes.remove(&repo_id);
                    return;
                }
            };
        }
    });
}

async fn refresh_repo_status_once(
    store: &dyn WorkspaceStore,
    git: &dyn GitBackend,
    repo_id: RepositoryId,
) -> Result<RepoStatusSummary, WorkspaceError> {
    let repo = store.get_repository(repo_id).await?;
    let status = git.status(&RepoPath::new(repo.path)).await?;
    Ok(store.upsert_repo_status(repo_id, &status).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use fjord_domain::{
        BranchInfo, CommitPage, CommitSummary, FileChangeType, FileDiff, FileDiffDetail, LogCursor,
        RepoStatus, RepositoryId, StashEntry, TagInfo, WorkingChanges,
    };
    use std::path::PathBuf as StdPathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    struct FakeWorkspaceStore {
        workspaces: Mutex<Vec<Workspace>>,
        repos: Mutex<Vec<RepositoryEntry>>,
    }

    #[async_trait]
    impl WorkspaceStore for FakeWorkspaceStore {
        async fn list_workspaces(&self) -> Result<Vec<Workspace>, StoreError> {
            Ok(self.workspaces.lock().unwrap().clone())
        }
        async fn create_workspace(&self, name: &str) -> Result<Workspace, StoreError> {
            let ws = Workspace {
                id: WorkspaceId::new(),
                name: name.to_string(),
                sort_order: 0,
            };
            self.workspaces.lock().unwrap().push(ws.clone());
            Ok(ws)
        }
        async fn rename_workspace(
            &self,
            id: WorkspaceId,
            name: &str,
        ) -> Result<Workspace, StoreError> {
            let mut wss = self.workspaces.lock().unwrap();
            let ws = wss
                .iter_mut()
                .find(|w| w.id == id)
                .ok_or(StoreError::WorkspaceNotFound(id))?;
            ws.name = name.to_string();
            Ok(ws.clone())
        }
        async fn reorder_workspaces(&self, _ids: &[WorkspaceId]) -> Result<(), StoreError> {
            Ok(())
        }
        async fn delete_workspace(&self, id: WorkspaceId) -> Result<(), StoreError> {
            self.workspaces.lock().unwrap().retain(|w| w.id != id);
            Ok(())
        }
        async fn list_repositories(
            &self,
            workspace_id: WorkspaceId,
        ) -> Result<Vec<RepositoryEntry>, StoreError> {
            Ok(self
                .repos
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.workspace_id == workspace_id)
                .cloned()
                .collect())
        }
        async fn list_all_repositories(&self) -> Result<Vec<RepositoryEntry>, StoreError> {
            Ok(self.repos.lock().unwrap().clone())
        }
        async fn get_repository(&self, id: RepositoryId) -> Result<RepositoryEntry, StoreError> {
            self.repos
                .lock()
                .unwrap()
                .iter()
                .find(|r| r.id == id)
                .cloned()
                .ok_or(StoreError::RepositoryNotFound(id))
        }
        async fn add_repository(
            &self,
            workspace_id: WorkspaceId,
            name: &str,
            path: &std::path::Path,
        ) -> Result<RepositoryEntry, StoreError> {
            let entry = RepositoryEntry {
                id: RepositoryId::new(),
                workspace_id,
                name: name.to_string(),
                path: path.to_path_buf(),
                sort_order: 0,
            };
            self.repos.lock().unwrap().push(entry.clone());
            Ok(entry)
        }
        async fn remove_repository(&self, id: RepositoryId) -> Result<(), StoreError> {
            self.repos.lock().unwrap().retain(|r| r.id != id);
            Ok(())
        }
        async fn list_workspace_status(
            &self,
            workspace_id: WorkspaceId,
        ) -> Result<Vec<RepoStatusSummary>, StoreError> {
            Ok(self
                .repos
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.workspace_id == workspace_id)
                .map(|r| RepoStatusSummary {
                    repo_id: r.id,
                    status: fjord_domain::RepoStatus {
                        branch: None,
                        ahead: 0,
                        behind: 0,
                        dirty_count: 0,
                        has_conflict: false,
                    },
                    last_synced_at: None,
                })
                .collect())
        }
        async fn upsert_repo_status(
            &self,
            repo_id: RepositoryId,
            status: &fjord_domain::RepoStatus,
        ) -> Result<RepoStatusSummary, StoreError> {
            Ok(RepoStatusSummary {
                repo_id,
                status: status.clone(),
                last_synced_at: Some(time::OffsetDateTime::UNIX_EPOCH),
            })
        }
        async fn invalidate_repo_status(&self, _repo_id: RepositoryId) -> Result<(), StoreError> {
            Ok(())
        }
    }

    struct FakeGitBackend {
        valid_repo: bool,
        status_probe: Option<Arc<StatusProbe>>,
    }

    struct StatusProbe {
        calls: AtomicUsize,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
        started_tx: Mutex<mpsc::Sender<usize>>,
        release_rx: Mutex<mpsc::Receiver<()>>,
    }

    impl StatusProbe {
        fn new(started_tx: mpsc::Sender<usize>, release_rx: mpsc::Receiver<()>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                in_flight: AtomicUsize::new(0),
                max_in_flight: AtomicUsize::new(0),
                started_tx: Mutex::new(started_tx),
                release_rx: Mutex::new(release_rx),
            }
        }

        fn record_status_call(&self) {
            let in_flight = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(in_flight, Ordering::SeqCst);

            let calls = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            self.started_tx.lock().unwrap().send(calls).unwrap();
            self.release_rx.lock().unwrap().recv().unwrap();

            self.in_flight.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl GitBackend for FakeGitBackend {
        async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError> {
            if let Some(probe) = &self.status_probe {
                probe.record_status_call();
            }

            if self.valid_repo {
                Ok(RepoStatus {
                    branch: Some("main".into()),
                    ahead: 0,
                    behind: 0,
                    dirty_count: 0,
                    has_conflict: false,
                })
            } else {
                Err(GitError::NotAGitRepository(repo.0.clone()))
            }
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
            Ok(CommitPage {
                commits: vec![],
                next_cursor: None,
            })
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
            path: &str,
        ) -> Result<FileDiffDetail, GitError> {
            Ok(FileDiffDetail {
                path: path.to_string(),
                change_type: FileChangeType::Modified,
                is_binary: false,
                hunks: vec![],
            })
        }
        async fn checkout(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
            Ok(())
        }
        async fn working_changes(&self, _repo: &RepoPath) -> Result<WorkingChanges, GitError> {
            Ok(WorkingChanges::default())
        }
        async fn working_file_diff(
            &self,
            _repo: &RepoPath,
            path: &str,
            _staged: bool,
        ) -> Result<FileDiffDetail, GitError> {
            Ok(FileDiffDetail {
                path: path.to_string(),
                change_type: FileChangeType::Modified,
                is_binary: false,
                hunks: vec![],
            })
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
        async fn stage(&self, _repo: &RepoPath, _paths: &[StdPathBuf]) -> Result<(), GitError> {
            Ok(())
        }
        async fn unstage(&self, _repo: &RepoPath, _paths: &[StdPathBuf]) -> Result<(), GitError> {
            Ok(())
        }
        async fn commit(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> {
            Ok("deadbeef".into())
        }
        async fn open_merge_tool(&self, _repo: &RepoPath) -> Result<(), GitError> {
            Ok(())
        }
    }

    fn service(valid_repo: bool) -> WorkspaceService {
        WorkspaceService::new(
            Arc::new(FakeWorkspaceStore {
                workspaces: Mutex::new(vec![]),
                repos: Mutex::new(vec![]),
            }),
            Arc::new(FakeGitBackend {
                valid_repo,
                status_probe: None,
            }),
        )
    }

    #[tokio::test]
    async fn adding_a_real_repo_persists_it_with_a_derived_name() {
        let service = service(true);
        let ws = service.create_workspace("Backend").await.unwrap();
        let entry = service
            .add_repository(ws.id, PathBuf::from("/repos/api-gateway"))
            .await
            .unwrap();
        assert_eq!(entry.name, "api-gateway");
        assert_eq!(service.list_repositories(ws.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn adding_a_non_git_folder_is_rejected() {
        let service = service(false);
        let ws = service.create_workspace("Backend").await.unwrap();
        let result = service
            .add_repository(ws.id, PathBuf::from("/not/a/repo"))
            .await;
        assert!(matches!(result, Err(WorkspaceError::NotAGitRepository(_))));
        assert_eq!(service.list_repositories(ws.id).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn adding_the_same_repository_twice_is_rejected_before_persisting() {
        let service = service(true);
        let ws = service.create_workspace("Backend").await.unwrap();
        let path = PathBuf::from("/repos/api-gateway");
        service.add_repository(ws.id, path.clone()).await.unwrap();

        let result = service.add_repository(ws.id, path.clone()).await;

        assert!(matches!(
            result,
            Err(WorkspaceError::RepositoryAlreadyAdded(duplicate)) if duplicate == path
        ));
        assert_eq!(service.list_repositories(ws.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn equivalent_filesystem_paths_are_treated_as_the_same_repository() {
        let service = service(true);
        let ws = service.create_workspace("Backend").await.unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let repository = root.path().join("repository");
        std::fs::create_dir_all(repository.join("nested")).unwrap();

        service
            .add_repository(ws.id, repository.clone())
            .await
            .unwrap();
        let result = service
            .add_repository(ws.id, repository.join("nested/.."))
            .await;

        assert!(matches!(
            result,
            Err(WorkspaceError::RepositoryAlreadyAdded(_))
        ));
        assert_eq!(service.list_repositories(ws.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_same_repository_can_belong_to_different_workspaces() {
        let service = service(true);
        let backend = service.create_workspace("Backend").await.unwrap();
        let frontend = service.create_workspace("Frontend").await.unwrap();
        let path = PathBuf::from("/repos/shared");

        service
            .add_repository(backend.id, path.clone())
            .await
            .unwrap();
        service.add_repository(frontend.id, path).await.unwrap();

        assert_eq!(
            service.list_repositories(backend.id).await.unwrap().len(),
            1
        );
        assert_eq!(
            service.list_repositories(frontend.id).await.unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn workspace_crud_delegates_to_store() {
        let service = service(true);
        let first = service.create_workspace("Backend").await.unwrap();
        let second = service.create_workspace("Frontend").await.unwrap();

        let renamed = service.rename_workspace(first.id, "Core").await.unwrap();
        assert_eq!(renamed.name, "Core");

        service
            .reorder_workspaces(&[second.id, first.id])
            .await
            .unwrap();
        service.delete_workspace(second.id).await.unwrap();

        let remaining = service.list_workspaces().await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, first.id);
    }

    #[tokio::test]
    async fn remove_repository_delegates_to_store() {
        let service = service(true);
        let ws = service.create_workspace("Backend").await.unwrap();
        let entry = service
            .add_repository(ws.id, PathBuf::from("/repos/api-gateway"))
            .await
            .unwrap();

        service.remove_repository(entry.id).await.unwrap();

        assert_eq!(service.list_repositories(ws.id).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn workspace_status_returns_cached_rows_and_schedules_refresh() {
        let service = service(true);
        let ws = service.create_workspace("Backend").await.unwrap();
        let entry = service
            .add_repository(ws.id, PathBuf::from("/repos/api-gateway"))
            .await
            .unwrap();

        let cached = service.get_workspace_status(ws.id).await.unwrap();

        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].repo_id, entry.id);
        assert!(cached[0].last_synced_at.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn scheduled_status_refreshes_are_coalesced_per_repo() {
        let workspace_id = WorkspaceId::new();
        let repo = RepositoryEntry {
            id: RepositoryId::new(),
            workspace_id,
            name: "api-gateway".into(),
            path: PathBuf::from("/repos/api-gateway"),
            sort_order: 0,
        };
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let probe = Arc::new(StatusProbe::new(started_tx, release_rx));
        let service = WorkspaceService::new(
            Arc::new(FakeWorkspaceStore {
                workspaces: Mutex::new(vec![Workspace {
                    id: workspace_id,
                    name: "Backend".into(),
                    sort_order: 0,
                }]),
                repos: Mutex::new(vec![repo.clone()]),
            }),
            Arc::new(FakeGitBackend {
                valid_repo: true,
                status_probe: Some(probe.clone()),
            }),
        );

        service.schedule_repo_status_refresh(repo.id, false);
        service.schedule_repo_status_refresh(repo.id, false);
        service.schedule_repo_status_refresh(repo.id, false);

        assert_eq!(started_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        assert!(started_rx.recv_timeout(Duration::from_millis(100)).is_err());

        release_tx.send(()).unwrap();
        assert_eq!(started_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 2);

        release_tx.send(()).unwrap();
        assert!(started_rx.recv_timeout(Duration::from_millis(200)).is_err());
        assert_eq!(probe.calls.load(Ordering::SeqCst), 2);
        assert_eq!(probe.max_in_flight.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refresh_repo_status_reads_live_git_and_updates_cache() {
        let service = service(true);
        let ws = service.create_workspace("Backend").await.unwrap();
        let entry = service
            .add_repository(ws.id, PathBuf::from("/repos/api-gateway"))
            .await
            .unwrap();

        let refreshed = service.refresh_repo_status(entry.id).await.unwrap();

        assert_eq!(refreshed.repo_id, entry.id);
        assert_eq!(refreshed.status.branch.as_deref(), Some("main"));
        assert!(refreshed.last_synced_at.is_some());
    }
}
