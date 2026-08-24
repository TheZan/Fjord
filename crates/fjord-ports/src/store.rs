//! `WorkspaceStore` and `SettingsStore` ports, implemented by `fjord-db`.
//! See docs/specs/data-model.md for the underlying schema.

use async_trait::async_trait;
use fjord_domain::{
    RepoStatus, RepoStatusSummary, RepositoryEntry, RepositoryId, RepositorySnapshot, Settings,
    StoredRepositorySnapshot, UiState, Workspace, WorkspaceId,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("workspace not found: {0:?}")]
    WorkspaceNotFound(WorkspaceId),
    #[error("repository not found: {0:?}")]
    RepositoryNotFound(RepositoryId),
    #[error("repository is already in this workspace: {0}")]
    RepositoryAlreadyExists(std::path::PathBuf),
    #[error("database error: {0}")]
    Database(String),
    #[error("invalid setting: {0}")]
    InvalidSetting(&'static str),
}

#[async_trait]
pub trait WorkspaceStore: Send + Sync {
    async fn list_workspaces(&self) -> Result<Vec<Workspace>, StoreError>;
    async fn create_workspace(&self, name: &str) -> Result<Workspace, StoreError>;
    async fn rename_workspace(&self, id: WorkspaceId, name: &str) -> Result<Workspace, StoreError>;
    async fn reorder_workspaces(&self, ids: &[WorkspaceId]) -> Result<(), StoreError>;
    async fn delete_workspace(&self, id: WorkspaceId) -> Result<(), StoreError>;

    async fn list_repositories(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<RepositoryEntry>, StoreError>;
    async fn list_all_repositories(&self) -> Result<Vec<RepositoryEntry>, StoreError>;
    async fn get_repository(&self, id: RepositoryId) -> Result<RepositoryEntry, StoreError>;
    async fn add_repository(
        &self,
        workspace_id: WorkspaceId,
        name: &str,
        path: &std::path::Path,
    ) -> Result<RepositoryEntry, StoreError>;
    async fn remove_repository(&self, id: RepositoryId) -> Result<(), StoreError>;

    async fn list_workspace_status(
        &self,
        workspace_id: WorkspaceId,
    ) -> Result<Vec<RepoStatusSummary>, StoreError>;
    async fn upsert_repo_status(
        &self,
        repo_id: RepositoryId,
        status: &RepoStatus,
    ) -> Result<RepoStatusSummary, StoreError>;
    async fn invalidate_repo_status(&self, repo_id: RepositoryId) -> Result<(), StoreError>;
    async fn load_repository_snapshot(
        &self,
        _repo_id: RepositoryId,
        _schema_version: u32,
    ) -> Result<Option<StoredRepositorySnapshot>, StoreError> {
        Ok(None)
    }
    async fn upsert_repository_snapshot(
        &self,
        _repo_id: RepositoryId,
        _schema_version: u32,
        _snapshot: &RepositorySnapshot,
    ) -> Result<StoredRepositorySnapshot, StoreError> {
        Err(StoreError::Database(
            "repository snapshots are not supported by this store".to_string(),
        ))
    }
}

#[async_trait]
pub trait SettingsStore: Send + Sync {
    async fn get_settings(&self) -> Result<Settings, StoreError>;
    async fn update_settings(&self, settings: &Settings) -> Result<Settings, StoreError>;
}

#[async_trait]
pub trait UiStateStore: Send + Sync {
    async fn get_ui_state(&self) -> Result<UiState, StoreError>;
    async fn update_ui_state(&self, state: &UiState) -> Result<UiState, StoreError>;
}
