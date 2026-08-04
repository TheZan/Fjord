use std::path::PathBuf;

use fjord_domain::{RepoStatusSummary, RepositoryEntry, RepositoryId, Workspace, WorkspaceId};
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, AppError> {
    Ok(state.workspaces.list_workspaces().await?)
}

#[tauri::command]
pub async fn create_workspace(
    state: State<'_, AppState>,
    name: String,
) -> Result<Workspace, AppError> {
    Ok(state.workspaces.create_workspace(&name).await?)
}

#[tauri::command]
pub async fn rename_workspace(
    state: State<'_, AppState>,
    id: WorkspaceId,
    name: String,
) -> Result<Workspace, AppError> {
    Ok(state.workspaces.rename_workspace(id, &name).await?)
}

#[tauri::command]
pub async fn reorder_workspaces(
    state: State<'_, AppState>,
    ids: Vec<WorkspaceId>,
) -> Result<(), AppError> {
    Ok(state.workspaces.reorder_workspaces(&ids).await?)
}

#[tauri::command]
pub async fn delete_workspace(state: State<'_, AppState>, id: WorkspaceId) -> Result<(), AppError> {
    Ok(state.workspaces.delete_workspace(id).await?)
}

#[tauri::command]
pub async fn list_repositories(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
) -> Result<Vec<RepositoryEntry>, AppError> {
    Ok(state.workspaces.list_repositories(workspace_id).await?)
}

#[tauri::command]
pub async fn get_workspace_status(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
) -> Result<Vec<RepoStatusSummary>, AppError> {
    Ok(state.workspaces.get_workspace_status(workspace_id).await?)
}

#[tauri::command]
pub async fn refresh_repo_status(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<RepoStatusSummary, AppError> {
    Ok(state.workspaces.refresh_repo_status(repo_id).await?)
}

#[tauri::command]
pub async fn add_repository(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    path: PathBuf,
) -> Result<RepositoryEntry, AppError> {
    let entry = state.workspaces.add_repository(workspace_id, path).await?;
    let _ = state.workspaces.refresh_repo_status(entry.id).await;
    state.watch_repository_status(entry.clone());
    Ok(entry)
}

#[tauri::command]
pub async fn remove_repository(
    state: State<'_, AppState>,
    id: RepositoryId,
) -> Result<(), AppError> {
    state.unwatch_repository_status(id);
    Ok(state.workspaces.remove_repository(id).await?)
}
