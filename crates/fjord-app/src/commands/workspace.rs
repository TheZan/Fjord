use std::path::PathBuf;

use crate::error::AppError;
use crate::interaction_traces::TracedState;
use crate::interaction_traces::TracedState as State;
use crate::operations::{
    emit_operation, OperationKind, OperationProgress, OperationRegistry, OperationScope,
    OperationStatus,
};
use crate::state::AppState;
use fjord_domain::{
    CloneRepositoryRequest, CloneRepositoryResult, RepoStatusSummary, RepositoryEntry,
    RepositoryId, Workspace, WorkspaceId,
};
use fjord_services::WorkspaceError;
use tauri::AppHandle;

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
pub async fn clone_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CloneRepositoryRequest,
    operation_id: Option<String>,
) -> Result<CloneRepositoryResult, AppError> {
    // Invalid workspace/destination state must fail before an operation exists.
    let prepared = state.repos.prepare_clone_repository(request).await?;
    let workspace_id = prepared.workspace_id();
    let repository_name = prepared.directory_name().to_string();
    let operation_id = operation_id.unwrap_or_else(OperationRegistry::next_id);
    let guard = state.operations.begin(operation_id);
    let kind = OperationKind::Clone;
    let scope = OperationScope::Workspace { workspace_id };
    emit_operation(
        &app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope: scope.clone(),
            status: OperationStatus::Started,
            repo_id: None,
            completed: 0,
            total: 1,
            message: Some(repository_name.clone()),
            error: None,
        },
    );

    let askpass = state.begin_askpass_operation(
        guard.id(),
        Some(repository_name),
        Some(kind.as_str().to_string()),
    );
    let context = guard
        .git_context_for_scope(app.clone(), kind, scope.clone(), None)
        .with_askpass(askpass);
    let result = if guard.is_cancelled() {
        Err(AppError::operation_cancelled())
    } else {
        match state
            .repos
            .clone_repository_with_context(prepared, context)
            .await
            .map_err(AppError::from)
        {
            Ok(result) => state
                .refresh_repository_tiers()
                .await
                .map(|_| result)
                .map_err(AppError::from),
            Err(error) => Err(error),
        }
    };
    state.askpass.finish_operation(guard.id());

    let (status, completed, repo_id, error) = match &result {
        Ok(result) => (
            OperationStatus::Succeeded,
            1,
            Some(result.repository.id),
            None,
        ),
        Err(error) if error.code == "operation_cancelled" => {
            (OperationStatus::Cancelled, 0, None, None)
        }
        Err(error) => (
            OperationStatus::Failed,
            0,
            None,
            error
                .diagnostics
                .clone()
                .or_else(|| Some(error.message.clone())),
        ),
    };
    emit_operation(
        &app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope,
            status,
            repo_id,
            completed,
            total: 1,
            message: None,
            error,
        },
    );

    result
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
