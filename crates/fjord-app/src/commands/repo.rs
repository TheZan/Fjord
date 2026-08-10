use fjord_domain::{
    BranchInfo, BulkRepoResult, CommitPage, CommitSummary, FileDiff, FileDiffWindow, GenerationSet,
    GitConnectionTestResult, GlobalSearchResult, LogCursor, RepoStatus, RepositoryId,
    SnapshotRevalidation, StashEntry, StoredRepositorySnapshot, TagInfo, WorkingChanges,
    WorkspaceId,
};
use serde::Serialize;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::AppError;
use crate::interaction_traces::TracedState as State;
use crate::operations::{
    emit_operation, OperationKind, OperationProgress, OperationRegistry, OperationScope,
    OperationStatus,
};
use crate::state::AppState;

const BULK_WORKER_LIMIT: usize = 6;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationEnvelope<T> {
    data: T,
    generations: GenerationSet,
}

async fn versioned<T>(
    state: &AppState,
    repo_id: RepositoryId,
    data: T,
) -> Result<GenerationEnvelope<T>, AppError> {
    Ok(GenerationEnvelope {
        data,
        generations: state.repos.get_generations(repo_id).await?,
    })
}

#[tauri::command]
pub async fn get_branches(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<Vec<BranchInfo>>, AppError> {
    let data = state.repos.get_branches(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_tags(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<Vec<TagInfo>>, AppError> {
    let data = state.repos.get_tags(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_repo_status(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<RepoStatus>, AppError> {
    let data = state.repos.get_status(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_repository_snapshot(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<Option<StoredRepositorySnapshot>, AppError> {
    Ok(state.repos.load_repository_snapshot(repo_id).await?)
}

#[tauri::command]
pub async fn capture_repository_snapshot(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<StoredRepositorySnapshot, AppError> {
    Ok(state.repos.capture_repository_snapshot(repo_id).await?)
}

#[tauri::command]
pub async fn revalidate_repository_snapshot(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<SnapshotRevalidation, AppError> {
    Ok(state.repos.revalidate_repository_snapshot(repo_id).await?)
}

#[tauri::command]
pub async fn get_commit_log(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    cursor: Option<LogCursor>,
    limit: u32,
) -> Result<GenerationEnvelope<CommitPage>, AppError> {
    let data = state.repos.get_commit_log(repo_id, cursor, limit).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn search_commit_log(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    query: String,
    limit: u32,
) -> Result<GenerationEnvelope<Vec<CommitSummary>>, AppError> {
    let data = state
        .repos
        .search_commit_log(repo_id, &query, limit)
        .await?;
    versioned(&state, repo_id, data).await
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
) -> Result<GenerationEnvelope<Vec<FileDiff>>, AppError> {
    let data = state.repos.get_commit_diff(repo_id, &commit_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_commit_files(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<GenerationEnvelope<Vec<FileDiff>>, AppError> {
    let data = state.repos.get_commit_files(repo_id, &commit_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
    path: String,
    offset: u32,
    limit: u32,
) -> Result<GenerationEnvelope<FileDiffWindow>, AppError> {
    let data = state
        .repos
        .get_file_diff(repo_id, &commit_id, &path, offset, limit)
        .await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    branch: String,
) -> Result<(), AppError> {
    let operation_id = OperationRegistry::next_id();
    let askpass = state.begin_askpass_operation(
        &operation_id,
        state.repos.repository_name(repo_id).await,
        Some("checkout-remote-branch".to_string()),
    );
    let result = state
        .repos
        .checkout_branch_with_context(
            repo_id,
            &branch,
            fjord_ports::GitOperationContext::default().with_askpass(askpass),
        )
        .await;
    state.askpass.finish_operation(&operation_id);
    Ok(result?)
}

#[tauri::command]
pub async fn get_working_changes(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<WorkingChanges>, AppError> {
    let data = state.repos.get_working_changes(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_working_file_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
    staged: bool,
    offset: u32,
    limit: u32,
) -> Result<GenerationEnvelope<FileDiffWindow>, AppError> {
    let data = state
        .repos
        .get_working_file_diff(repo_id, &path, staged, offset, limit)
        .await?;
    versioned(&state, repo_id, data).await
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
pub async fn create_branch_at(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    target: String,
    checkout: bool,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .create_branch_at(repo_id, &name, &target, checkout)
        .await?)
}

#[tauri::command]
pub async fn rename_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    old_name: String,
    new_name: String,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .rename_branch(repo_id, &old_name, &new_name)
        .await?)
}

#[tauri::command]
pub async fn delete_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
) -> Result<(), AppError> {
    Ok(state.repos.delete_branch(repo_id, &name).await?)
}

#[tauri::command]
pub async fn delete_remote_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
) -> Result<(), AppError> {
    let operation_id = OperationRegistry::next_id();
    let askpass = state.begin_askpass_operation(
        &operation_id,
        state.repos.repository_name(repo_id).await,
        Some("delete-remote-branch".to_string()),
    );
    let result = state
        .repos
        .delete_remote_branch_with_context(
            repo_id,
            &name,
            fjord_ports::GitOperationContext::default().with_askpass(askpass),
        )
        .await;
    state.askpass.finish_operation(&operation_id);
    Ok(result?)
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    target: String,
) -> Result<(), AppError> {
    Ok(state.repos.create_tag(repo_id, &name, &target).await?)
}

#[tauri::command]
pub async fn delete_tag(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
) -> Result<(), AppError> {
    Ok(state.repos.delete_tag(repo_id, &name).await?)
}

#[tauri::command]
pub async fn cherry_pick(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<(), AppError> {
    Ok(state.repos.cherry_pick(repo_id, &commit_id).await?)
}

#[tauri::command]
pub async fn revert_commit(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<(), AppError> {
    Ok(state.repos.revert(repo_id, &commit_id).await?)
}

#[tauri::command]
pub async fn reset_to_commit(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
    mode: String,
) -> Result<(), AppError> {
    Ok(state.repos.reset(repo_id, &commit_id, &mode).await?)
}

#[tauri::command]
pub async fn get_stashes(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<Vec<StashEntry>>, AppError> {
    let data = state.repos.get_stashes(repo_id).await?;
    versioned(&state, repo_id, data).await
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

/// Publishes a branch that has no upstream yet. Separate from `push_repo`
/// because it is the user's explicit answer to `no_upstream`.
#[tauri::command]
pub async fn publish_branch(
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
        OperationKind::Publish,
        repo_id,
        |context| {
            let repos = state.repos.clone();
            let remote = remote.clone();
            async move {
                repos
                    .publish_branch_with_context(repo_id, remote.as_deref(), context)
                    .await
            }
        },
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
    let cancelled = state.operations.cancel(&operation_id);
    state.askpass.cancel_operation(&operation_id);
    Ok(cancelled)
}

#[tauri::command]
pub async fn test_git_connection(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    remote: Option<String>,
) -> Result<GitConnectionTestResult, AppError> {
    let operation_id = OperationRegistry::next_id();
    let askpass = state.begin_askpass_operation(
        &operation_id,
        state.repos.repository_name(repo_id).await,
        Some("connection-test".to_string()),
    );
    let result = state
        .repos
        .test_git_connection_with_context(
            repo_id,
            remote.as_deref().unwrap_or("origin"),
            fjord_ports::GitOperationContext::default().with_askpass(askpass),
        )
        .await;
    state.askpass.finish_operation(&operation_id);
    Ok(result?)
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

    let askpass = state.begin_askpass_operation(
        guard.id(),
        state.repos.repository_name(repo_id).await,
        Some(kind.as_str().to_string()),
    );
    let context = guard
        .git_context(app.clone(), kind, scope.clone(), repo_id)
        .with_askpass(askpass);
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

    state.askpass.finish_operation(guard.id());
    let (status, completed, error) = match &result {
        Ok(()) => (OperationStatus::Succeeded, 1, None),
        Err(error) if error.code == "operation_cancelled" => (OperationStatus::Cancelled, 0, None),
        Err(error) => (
            OperationStatus::Failed,
            0,
            error
                .diagnostics
                .clone()
                .or_else(|| Some(error.message.clone())),
        ),
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
        // A prompt during a bulk run has to say which repository is asking,
        // so every repository gets its own session under the bulk operation.
        let repo_operation_id =
            crate::askpass::sub_operation_id(guard.id(), &repo_id.0.to_string());
        let askpass = state.begin_askpass_operation(
            &repo_operation_id,
            Some(repo.name.clone()),
            Some(kind.as_str().to_string()),
        );
        let broker = state.askpass.clone();
        let context = guard
            .git_context(app.clone(), kind, scope.clone(), repo_id)
            .with_askpass(askpass);
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
            broker.finish_operation(&repo_operation_id);
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
        state.askpass.finish_operation(guard.id());
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

    state.askpass.finish_operation(guard.id());

    Ok(results)
}
