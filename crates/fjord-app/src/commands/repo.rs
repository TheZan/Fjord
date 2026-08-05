use fjord_domain::{
    BranchInfo, BulkRepoResult, CommitPage, CommitSummary, FileDiff, FileDiffDetail,
    GlobalSearchResult, LogCursor, RepoStatus, RepositoryId, StashEntry, TagInfo, WorkingChanges,
    WorkspaceId,
};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::AppError;
use crate::operations::{
    emit_operation, OperationKind, OperationProgress, OperationRegistry, OperationScope,
    OperationStatus,
};
use crate::state::AppState;

const BULK_WORKER_LIMIT: usize = 6;

#[tauri::command]
pub async fn get_branches(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<Vec<BranchInfo>, AppError> {
    Ok(state.repos.get_branches(repo_id).await?)
}

#[tauri::command]
pub async fn get_tags(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<Vec<TagInfo>, AppError> {
    Ok(state.repos.get_tags(repo_id).await?)
}

#[tauri::command]
pub async fn get_repo_status(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<RepoStatus, AppError> {
    Ok(state.repos.get_status(repo_id).await?)
}

#[tauri::command]
pub async fn get_commit_log(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    cursor: Option<LogCursor>,
    limit: u32,
) -> Result<CommitPage, AppError> {
    Ok(state.repos.get_commit_log(repo_id, cursor, limit).await?)
}

#[tauri::command]
pub async fn search_commit_log(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    query: String,
    limit: u32,
) -> Result<Vec<CommitSummary>, AppError> {
    Ok(state
        .repos
        .search_commit_log(repo_id, &query, limit)
        .await?)
}

#[tauri::command]
pub async fn global_search(
    state: State<'_, AppState>,
    workspace_id: Option<WorkspaceId>,
    query: String,
    limit: u32,
) -> Result<Vec<GlobalSearchResult>, AppError> {
    Ok(state
        .repos
        .global_search(workspace_id, &query, limit)
        .await?)
}

#[tauri::command]
pub async fn get_commit_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<Vec<FileDiff>, AppError> {
    Ok(state.repos.get_commit_diff(repo_id, &commit_id).await?)
}

#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
    path: String,
) -> Result<FileDiffDetail, AppError> {
    Ok(state
        .repos
        .get_file_diff(repo_id, &commit_id, &path)
        .await?)
}

#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    branch: String,
) -> Result<(), AppError> {
    Ok(state.repos.checkout_branch(repo_id, &branch).await?)
}

#[tauri::command]
pub async fn get_working_changes(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<WorkingChanges, AppError> {
    Ok(state.repos.get_working_changes(repo_id).await?)
}

#[tauri::command]
pub async fn get_working_file_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
    staged: bool,
) -> Result<FileDiffDetail, AppError> {
    Ok(state
        .repos
        .get_working_file_diff(repo_id, &path, staged)
        .await?)
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    checkout: bool,
) -> Result<(), AppError> {
    Ok(state.repos.create_branch(repo_id, &name, checkout).await?)
}

#[tauri::command]
pub async fn get_stashes(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<Vec<StashEntry>, AppError> {
    Ok(state.repos.get_stashes(repo_id).await?)
}

#[tauri::command]
pub async fn stash_push(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    message: Option<String>,
) -> Result<(), AppError> {
    Ok(state.repos.stash_push(repo_id, message.as_deref()).await?)
}

#[tauri::command]
pub async fn stash_pop(state: State<'_, AppState>, repo_id: RepositoryId) -> Result<(), AppError> {
    Ok(state.repos.stash_pop(repo_id).await?)
}

#[tauri::command]
pub async fn open_terminal(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<(), AppError> {
    Ok(state.repos.open_terminal(repo_id).await?)
}

#[tauri::command]
pub async fn stage_files(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    paths: Vec<PathBuf>,
) -> Result<(), AppError> {
    Ok(state.repos.stage_files(repo_id, &paths).await?)
}

#[tauri::command]
pub async fn unstage_files(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    paths: Vec<PathBuf>,
) -> Result<(), AppError> {
    Ok(state.repos.unstage_files(repo_id, &paths).await?)
}

#[tauri::command]
pub async fn commit_repo(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    message: String,
) -> Result<String, AppError> {
    Ok(state.repos.commit(repo_id, &message).await?)
}

#[tauri::command]
pub async fn fetch_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    remote: Option<String>,
    operation_id: Option<String>,
) -> Result<(), AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Fetch,
        repo_id,
        |context| {
            state
                .repos
                .fetch_with_context(repo_id, remote.as_deref().unwrap_or("origin"), context)
        },
    )
    .await
}

#[tauri::command]
pub async fn pull_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    operation_id: Option<String>,
) -> Result<(), AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Pull,
        repo_id,
        |context| state.repos.pull_with_context(repo_id, context),
    )
    .await
}

#[tauri::command]
pub async fn push_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    operation_id: Option<String>,
) -> Result<(), AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Push,
        repo_id,
        |context| state.repos.push_with_context(repo_id, context),
    )
    .await
}

#[tauri::command]
pub async fn open_merge_tool(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<(), AppError> {
    Ok(state.repos.open_merge_tool(repo_id).await?)
}

#[tauri::command]
pub async fn open_in_ide(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    ide: Option<String>,
) -> Result<(), AppError> {
    Ok(state.repos.open_in_ide(repo_id, ide.as_deref()).await?)
}

#[tauri::command]
pub async fn bulk_fetch(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    operation_id: Option<String>,
) -> Result<Vec<BulkRepoResult>, AppError> {
    run_bulk_operation(
        app,
        state,
        operation_id,
        OperationKind::BulkFetch,
        BulkGitOperation::Fetch,
        workspace_id,
    )
    .await
}

#[tauri::command]
pub async fn bulk_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    operation_id: Option<String>,
) -> Result<Vec<BulkRepoResult>, AppError> {
    run_bulk_operation(
        app,
        state,
        operation_id,
        OperationKind::BulkPull,
        BulkGitOperation::Pull,
        workspace_id,
    )
    .await
}

#[tauri::command]
pub async fn bulk_open_in_ide(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    ide: Option<String>,
) -> Result<Vec<BulkRepoResult>, AppError> {
    Ok(state
        .repos
        .bulk_open_in_ide(workspace_id, ide.as_deref())
        .await?)
}

#[tauri::command]
pub async fn cancel_operation(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<bool, AppError> {
    Ok(state.operations.cancel(&operation_id))
}

async fn run_repo_operation<Fut>(
    app: &AppHandle,
    state: &AppState,
    operation_id: Option<String>,
    kind: OperationKind,
    repo_id: RepositoryId,
    run: impl FnOnce(fjord_ports::GitOperationContext) -> Fut,
) -> Result<(), AppError>
where
    Fut: Future<Output = Result<(), fjord_services::RepoError>>,
{
    let operation_id = operation_id.unwrap_or_else(OperationRegistry::next_id);
    let guard = state.operations.begin(operation_id);
    let scope = OperationScope::Repo { repo_id };
    emit_operation(
        app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope: scope.clone(),
            status: OperationStatus::Started,
            repo_id: Some(repo_id),
            completed: 0,
            total: 1,
            message: None,
            error: None,
        },
    );

    let context = guard.git_context(app.clone(), kind, scope.clone(), repo_id);
    let result = if guard.is_cancelled() {
        Err(AppError::operation_cancelled())
    } else {
        let result = run(context).await.map_err(AppError::from);
        if guard.is_cancelled() {
            Err(AppError::operation_cancelled())
        } else {
            result
        }
    };

    let (status, completed, error) = match &result {
        Ok(()) => (OperationStatus::Succeeded, 1, None),
        Err(error) if error.code == "operation_cancelled" => (OperationStatus::Cancelled, 0, None),
        Err(error) => (OperationStatus::Failed, 0, Some(error.message.clone())),
    };

    emit_operation(
        app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope,
            status,
            repo_id: Some(repo_id),
            completed,
            total: 1,
            message: None,
            error,
        },
    );

    result
}

#[derive(Clone, Copy)]
enum BulkGitOperation {
    Fetch,
    Pull,
}

async fn run_bulk_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    operation_id: Option<String>,
    kind: OperationKind,
    operation: BulkGitOperation,
    workspace_id: WorkspaceId,
) -> Result<Vec<BulkRepoResult>, AppError> {
    let operation_id = operation_id.unwrap_or_else(OperationRegistry::next_id);
    let guard = state.operations.begin(operation_id);
    let scope = OperationScope::Workspace { workspace_id };
    let repos = state.workspaces.list_repositories(workspace_id).await?;
    let total = repos.len() as u32;

    emit_operation(
        &app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope: scope.clone(),
            status: OperationStatus::Started,
            repo_id: None,
            completed: 0,
            total,
            message: None,
            error: None,
        },
    );

    let semaphore = Arc::new(Semaphore::new(BULK_WORKER_LIMIT));
    let mut tasks = JoinSet::new();

    for repo in repos {
        let permit = tokio::select! {
            _ = guard.cancelled() => break,
            permit = semaphore.clone().acquire_owned() => {
                permit.expect("bulk semaphore should stay open")
            }
        };
        let repo_id = repo.id;
        let service = state.repos.clone();
        let context = guard.git_context(app.clone(), kind, scope.clone(), repo_id);
        emit_operation(
            &app,
            OperationProgress {
                operation_id: guard.id().to_string(),
                kind,
                scope: scope.clone(),
                status: OperationStatus::RepoStarted,
                repo_id: Some(repo_id),
                completed: 0,
                total,
                message: Some(repo.name),
                error: None,
            },
        );

        tasks.spawn(async move {
            let result = match operation {
                BulkGitOperation::Fetch => {
                    service.fetch_with_context(repo_id, "origin", context).await
                }
                BulkGitOperation::Pull => service.pull_with_context(repo_id, context).await,
            };
            drop(permit);
            BulkRepoResult {
                repo_id,
                ok: result.is_ok(),
                error: result.err().map(|error| error.to_string()),
            }
        });
    }

    let mut completed = 0;
    let mut results = Vec::new();
    while !tasks.is_empty() {
        if let Some(Ok(result)) = tasks.join_next().await {
            completed += 1;
            emit_operation(
                &app,
                OperationProgress {
                    operation_id: guard.id().to_string(),
                    kind,
                    scope: scope.clone(),
                    status: OperationStatus::RepoFinished,
                    repo_id: Some(result.repo_id),
                    completed,
                    total,
                    message: None,
                    error: result.error.clone(),
                },
            );
            results.push(result);
        }
    }

    if guard.is_cancelled() {
        emit_operation(
            &app,
            OperationProgress {
                operation_id: guard.id().to_string(),
                kind,
                scope,
                status: OperationStatus::Cancelled,
                repo_id: None,
                completed,
                total,
                message: None,
                error: None,
            },
        );
        return Err(AppError::operation_cancelled());
    }

    emit_operation(
        &app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope,
            status: OperationStatus::Succeeded,
            repo_id: None,
            completed,
            total,
            message: None,
            error: None,
        },
    );

    Ok(results)
}
