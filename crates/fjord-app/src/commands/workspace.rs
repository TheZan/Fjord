use std::path::PathBuf;

use crate::error::AppError;
use crate::interaction_traces::TracedState;
use crate::interaction_traces::TracedState as State;
use crate::state::AppState;
use fjord_domain::{RepoStatusSummary, RepositoryEntry, RepositoryId, Workspace, WorkspaceId};
use fjord_services::WorkspaceError;

const IMPORT_REPOSITORY_LIMIT: usize = 200;

#[tauri::command]
pub async fn list_workspaces(state: TracedState<'_>) -> Result<Vec<Workspace>, AppError> {
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
pub async fn set_repository_activity(
    state: State<'_, AppState>,
    workspace_id: Option<WorkspaceId>,
    repo_id: Option<RepositoryId>,
) -> Result<(), AppError> {
    Ok(state.set_repository_activity(workspace_id, repo_id).await?)
}

#[tauri::command]
pub async fn add_repository(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    path: PathBuf,
) -> Result<RepositoryEntry, AppError> {
    let entry = state.workspaces.add_repository(workspace_id, path).await?;
    let _ = state.workspaces.refresh_repo_status(entry.id).await;
    state.refresh_repository_tiers().await?;
    Ok(entry)
}

#[tauri::command]
pub async fn import_repositories(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    root: PathBuf,
) -> Result<Vec<RepositoryEntry>, AppError> {
    let paths = fjord_fs::discover_git_repositories(&root, IMPORT_REPOSITORY_LIMIT)?;
    let mut imported = Vec::new();

    for path in paths {
        match state.workspaces.add_repository(workspace_id, path).await {
            Ok(entry) => {
                let _ = state.workspaces.refresh_repo_status(entry.id).await;
                imported.push(entry);
            }
            Err(WorkspaceError::RepositoryAlreadyAdded(_)) => {}
            Err(WorkspaceError::NotAGitRepository(_)) => {}
            Err(error) => return Err(error.into()),
        }
    }

    state.refresh_repository_tiers().await?;

    Ok(imported)
}

#[tauri::command]
pub async fn remove_repository(
    state: State<'_, AppState>,
    id: RepositoryId,
) -> Result<(), AppError> {
    state.workspaces.remove_repository(id).await?;
    state.refresh_repository_tiers().await?;
    Ok(())
}
