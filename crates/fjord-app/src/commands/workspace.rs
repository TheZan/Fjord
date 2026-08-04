use std::path::PathBuf;

use fjord_domain::{RepositoryEntry, Workspace, WorkspaceId};
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, AppError> {
    Ok(state.workspaces.list_workspaces().await?)
}

#[tauri::command]
pub async fn create_workspace(state: State<'_, AppState>, name: String) -> Result<Workspace, AppError> {
    Ok(state.workspaces.create_workspace(&name).await?)
}

#[tauri::command]
pub async fn list_repositories(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
) -> Result<Vec<RepositoryEntry>, AppError> {
    Ok(state.workspaces.list_repositories(workspace_id).await?)
}

#[tauri::command]
pub async fn add_repository(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    path: PathBuf,
) -> Result<RepositoryEntry, AppError> {
    Ok(state.workspaces.add_repository(workspace_id, path).await?)
}
