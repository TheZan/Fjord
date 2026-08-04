use std::path::{Path, PathBuf};
use std::sync::Arc;

use fjord_domain::{RepositoryEntry, Workspace, WorkspaceId};
use fjord_ports::{GitBackend, GitError, RepoPath, StoreError, WorkspaceStore};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("not a git repository: {0}")]
    NotAGitRepository(PathBuf),
    #[error("git error: {0}")]
    Git(String),
}

impl From<GitError> for WorkspaceError {
    fn from(err: GitError) -> Self {
        match err {
            GitError::NotAGitRepository(path) | GitError::RepoNotFound(path) => {
                WorkspaceError::NotAGitRepository(path)
            }
            other => WorkspaceError::Git(other.to_string()),
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
}

impl WorkspaceService {
    pub fn new(store: Arc<dyn WorkspaceStore>, git: Arc<dyn GitBackend>) -> Self {
        Self { store, git }
    }

    pub async fn list_workspaces(&self) -> Result<Vec<Workspace>, WorkspaceError> {
        Ok(self.store.list_workspaces().await?)
    }

    pub async fn create_workspace(&self, name: &str) -> Result<Workspace, WorkspaceError> {
        Ok(self.store.create_workspace(name).await?)
    }

    pub async fn list_repositories(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<RepositoryEntry>, WorkspaceError> {
        Ok(self.store.list_repositories(workspace_id).await?)
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
        self.git.status(&RepoPath::new(path.clone())).await?;

        let name = repo_display_name(&path);
        Ok(self.store.add_repository(workspace_id, &name, &path).await?)
    }

    pub async fn remove_repository(&self, id: fjord_domain::RepositoryId) -> Result<(), WorkspaceError> {
        Ok(self.store.remove_repository(id).await?)
    }
}

fn repo_display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use fjord_domain::{BranchInfo, CommitPage, FileDiff, LogCursor, RepoStatus, RepositoryId};
    use std::path::PathBuf as StdPathBuf;
    use std::sync::Mutex;

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
            let ws = Workspace { id: WorkspaceId::new(), name: name.to_string(), sort_order: 0 };
            self.workspaces.lock().unwrap().push(ws.clone());
            Ok(ws)
        }
        async fn rename_workspace(&self, id: WorkspaceId, name: &str) -> Result<Workspace, StoreError> {
            let mut wss = self.workspaces.lock().unwrap();
            let ws = wss.iter_mut().find(|w| w.id == id).ok_or(StoreError::WorkspaceNotFound(id))?;
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
        async fn list_repositories(&self, workspace_id: WorkspaceId) -> Result<Vec<RepositoryEntry>, StoreError> {
            Ok(self.repos.lock().unwrap().iter().filter(|r| r.workspace_id == workspace_id).cloned().collect())
        }
        async fn get_repository(&self, id: RepositoryId) -> Result<RepositoryEntry, StoreError> {
            self.repos.lock().unwrap().iter().find(|r| r.id == id).cloned().ok_or(StoreError::RepositoryNotFound(id))
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
    }

    struct FakeGitBackend {
        valid_repo: bool,
    }

    #[async_trait]
    impl GitBackend for FakeGitBackend {
        async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError> {
            if self.valid_repo {
                Ok(RepoStatus { branch: Some("main".into()), ahead: 0, behind: 0, dirty_count: 0, has_conflict: false })
            } else {
                Err(GitError::NotAGitRepository(repo.0.clone()))
            }
        }
        async fn branches(&self, _repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> { Ok(vec![]) }
        async fn log(&self, _repo: &RepoPath, _from: Option<LogCursor>, _limit: u32) -> Result<CommitPage, GitError> {
            Ok(CommitPage { commits: vec![], next_cursor: None })
        }
        async fn diff(&self, _repo: &RepoPath, _commit_id: &str) -> Result<Vec<FileDiff>, GitError> { Ok(vec![]) }
        async fn checkout(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> { Ok(()) }
        async fn stage(&self, _repo: &RepoPath, _paths: &[StdPathBuf]) -> Result<(), GitError> { Ok(()) }
        async fn commit(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> { Ok("deadbeef".into()) }
        async fn fetch(&self, _repo: &RepoPath, _remote: &str) -> Result<(), GitError> { Ok(()) }
        async fn pull(&self, _repo: &RepoPath) -> Result<(), GitError> { Ok(()) }
        async fn push(&self, _repo: &RepoPath, _refspec: &str) -> Result<(), GitError> { Ok(()) }
    }

    fn service(valid_repo: bool) -> WorkspaceService {
        WorkspaceService::new(
            Arc::new(FakeWorkspaceStore { workspaces: Mutex::new(vec![]), repos: Mutex::new(vec![]) }),
            Arc::new(FakeGitBackend { valid_repo }),
        )
    }

    #[tokio::test]
    async fn adding_a_real_repo_persists_it_with_a_derived_name() {
        let service = service(true);
        let ws = service.create_workspace("Backend").await.unwrap();
        let entry = service.add_repository(ws.id, PathBuf::from("/repos/api-gateway")).await.unwrap();
        assert_eq!(entry.name, "api-gateway");
        assert_eq!(service.list_repositories(ws.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn adding_a_non_git_folder_is_rejected() {
        let service = service(false);
        let ws = service.create_workspace("Backend").await.unwrap();
        let result = service.add_repository(ws.id, PathBuf::from("/not/a/repo")).await;
        assert!(matches!(result, Err(WorkspaceError::NotAGitRepository(_))));
        assert_eq!(service.list_repositories(ws.id).await.unwrap().len(), 0);
    }
}
