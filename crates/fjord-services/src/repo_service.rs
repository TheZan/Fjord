use std::sync::Arc;

use fjord_domain::{
    BranchInfo, CommitPage, FileDiff, FileDiffDetail, LogCursor, RepoStatus, RepositoryId,
};
use fjord_ports::{
    GitBackend, GitError, IdeLauncher, LaunchError, RepoPath, SettingsStore, StoreError,
    WorkspaceStore,
};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RepoError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Git(#[from] GitError),
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
    ide: Arc<dyn IdeLauncher>,
}

impl RepoService {
    pub fn new(
        workspaces: Arc<dyn WorkspaceStore>,
        settings: Arc<dyn SettingsStore>,
        git: Arc<dyn GitBackend>,
        ide: Arc<dyn IdeLauncher>,
    ) -> Self {
        Self {
            workspaces,
            settings,
            git,
            ide,
        }
    }

    pub async fn get_branches(&self, repo_id: RepositoryId) -> Result<Vec<BranchInfo>, RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.branches(&RepoPath::new(repo.path)).await?)
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

    pub async fn checkout_branch(
        &self,
        repo_id: RepositoryId,
        branch: &str,
    ) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.checkout(&RepoPath::new(repo.path), branch).await?)
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
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.fetch(&RepoPath::new(repo.path), remote).await?)
    }

    pub async fn pull(&self, repo_id: RepositoryId) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.pull(&RepoPath::new(repo.path)).await?)
    }

    pub async fn push(&self, repo_id: RepositoryId) -> Result<(), RepoError> {
        let repo = self.workspaces.get_repository(repo_id).await?;
        Ok(self.git.push(&RepoPath::new(repo.path), "").await?)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use fjord_domain::{
        CommitPage, FileChangeType, FileDiff, FileDiffDetail, LogCursor, RepoStatus,
        RepoStatusSummary, RepositoryEntry, Settings, Workspace, WorkspaceId,
    };
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    struct FakeStore {
        repo: RepositoryEntry,
    }

    struct FakeSettingsStore {
        settings: Settings,
    }

    struct FakeIdeLauncher {
        opened: Mutex<Option<(PathBuf, Option<String>)>>,
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
        async fn list_all_repositories(&self) -> Result<Vec<RepositoryEntry>, StoreError> {
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
    }

    struct FakeGit {
        seen_path: Mutex<Option<PathBuf>>,
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
        let git = Arc::new(FakeGit {
            seen_path: Mutex::new(None),
        });
        let ide = Arc::new(FakeIdeLauncher {
            opened: Mutex::new(None),
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
        async fn checkout(&self, repo: &RepoPath, _branch: &str) -> Result<(), GitError> {
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
        let service = RepoService::new(
            Arc::new(FakeStore { repo }),
            Arc::new(FakeSettingsStore {
                settings: Settings::default(),
            }),
            Arc::new(FakeGit {
                seen_path: Mutex::new(None),
            }),
            Arc::new(FakeIdeLauncher {
                opened: Mutex::new(None),
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
        let (repo, git, _, service) = service_with_fake_git();

        service.get_commit_log(repo.id, None, 20).await.unwrap();
        assert_eq!(*git.seen_path.lock().unwrap(), Some(repo.path));
    }

    #[tokio::test]
    async fn get_commit_diff_resolves_the_repo_id_too() {
        let (repo, git, _, service) = service_with_fake_git();

        let files = service.get_commit_diff(repo.id, "deadbeef").await.unwrap();
        assert_eq!(files.len(), 1);
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
}
