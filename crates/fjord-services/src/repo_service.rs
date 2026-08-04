use std::sync::Arc;

use fjord_domain::{BranchInfo, CommitPage, FileDiff, FileDiffDetail, LogCursor, RepositoryId};
use fjord_ports::{GitBackend, GitError, RepoPath, StoreError, WorkspaceStore};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RepoError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("git error: {0}")]
    Git(String),
}

impl From<GitError> for RepoError {
    fn from(err: GitError) -> Self {
        RepoError::Git(err.to_string())
    }
}

/// Read-side git queries scoped by `RepositoryId` rather than a raw path —
/// this is the layer that resolves "which repo is this" (via
/// `WorkspaceStore`) before ever calling into `GitBackend`, so command
/// handlers and the frontend only ever deal in IDs (SDD §5.1, §7).
pub struct RepoService {
    workspaces: Arc<dyn WorkspaceStore>,
    git: Arc<dyn GitBackend>,
}

impl RepoService {
    pub fn new(workspaces: Arc<dyn WorkspaceStore>, git: Arc<dyn GitBackend>) -> Self {
        Self { workspaces, git }
    }

    pub async fn get_branches(&self, repo_id: RepositoryId) -> Result<Vec<BranchInfo>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.branches(&RepoPath::new(repo.path)).await?)
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

    pub async fn get_commit_diff(
        &self,
        repo_id: RepositoryId,
        commit_id: &str,
    ) -> Result<Vec<FileDiff>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.diff(&RepoPath::new(repo.path), commit_id).await?)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use fjord_domain::{
        CommitPage, FileChangeType, FileDiff, FileDiffDetail, LogCursor, RepoStatus,
        RepositoryEntry, Workspace, WorkspaceId,
    };
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    struct FakeStore {
        repo: RepositoryEntry,
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
            unimplemented!()
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
    }

    struct FakeGit {
        seen_path: Mutex<Option<PathBuf>>,
    }

    #[async_trait]
    impl GitBackend for FakeGit {
        async fn status(&self, _repo: &RepoPath) -> Result<RepoStatus, GitError> {
            unimplemented!()
        }
        async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
            *self.seen_path.lock().unwrap() = Some(repo.0.clone());
            Ok(vec![BranchInfo {
                name: "main".into(),
                is_current: true,
                is_remote: false,
                upstream: None,
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
                commits: vec![],
                next_cursor: None,
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
                is_binary: false,
                hunks: vec![],
            })
        }
        async fn checkout(&self, _repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
            unimplemented!()
        }
        async fn stage(&self, _repo: &RepoPath, _paths: &[PathBuf]) -> Result<(), GitError> {
            unimplemented!()
        }
        async fn commit(&self, _repo: &RepoPath, _message: &str) -> Result<String, GitError> {
            unimplemented!()
        }
        async fn fetch(&self, _repo: &RepoPath, _remote: &str) -> Result<(), GitError> {
            unimplemented!()
        }
        async fn pull(&self, _repo: &RepoPath) -> Result<(), GitError> {
            unimplemented!()
        }
        async fn push(&self, _repo: &RepoPath, _refspec: &str) -> Result<(), GitError> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn resolves_the_repo_id_to_a_path_before_calling_git() {
        let repo = RepositoryEntry {
            id: RepositoryId::new(),
            workspace_id: WorkspaceId::new(),
            name: "api-gateway".into(),
            path: PathBuf::from("/repos/api-gateway"),
            sort_order: 0,
        };
        let git = Arc::new(FakeGit {
            seen_path: Mutex::new(None),
        });
        let service = RepoService::new(Arc::new(FakeStore { repo: repo.clone() }), git.clone());

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
        let service = RepoService::new(
            Arc::new(FakeStore { repo }),
            Arc::new(FakeGit {
                seen_path: Mutex::new(None),
            }),
        );

        let result = service.get_branches(RepositoryId::new()).await;
        assert!(matches!(
            result,
            Err(RepoError::Store(StoreError::RepositoryNotFound(_)))
        ));
    }

    #[tokio::test]
    async fn get_commit_log_resolves_the_repo_id_too() {
        let repo = RepositoryEntry {
            id: RepositoryId::new(),
            workspace_id: WorkspaceId::new(),
            name: "api-gateway".into(),
            path: PathBuf::from("/repos/api-gateway"),
            sort_order: 0,
        };
        let git = Arc::new(FakeGit {
            seen_path: Mutex::new(None),
        });
        let service = RepoService::new(Arc::new(FakeStore { repo: repo.clone() }), git.clone());

        service.get_commit_log(repo.id, None, 20).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn get_commit_diff_resolves_the_repo_id_too() {
        let repo = RepositoryEntry {
            id: RepositoryId::new(),
            workspace_id: WorkspaceId::new(),
            name: "api-gateway".into(),
            path: PathBuf::from("/repos/api-gateway"),
            sort_order: 0,
        };
        let git = Arc::new(FakeGit {
            seen_path: Mutex::new(None),
        });
        let service = RepoService::new(Arc::new(FakeStore { repo: repo.clone() }), git.clone());

        let files = service.get_commit_diff(repo.id, "deadbeef").await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn get_file_diff_resolves_the_repo_id_too() {
        let repo = RepositoryEntry {
            id: RepositoryId::new(),
            workspace_id: WorkspaceId::new(),
            name: "api-gateway".into(),
            path: PathBuf::from("/repos/api-gateway"),
            sort_order: 0,
        };
        let git = Arc::new(FakeGit {
            seen_path: Mutex::new(None),
        });
        let service = RepoService::new(Arc::new(FakeStore { repo: repo.clone() }), git.clone());

        let detail = service
            .get_file_diff(repo.id, "deadbeef", "src/main.rs")
            .await
            .unwrap();
        assert_eq!(detail.path, "src/main.rs");
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }
}
