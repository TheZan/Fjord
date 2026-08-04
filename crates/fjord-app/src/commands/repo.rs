use fjord_domain::{
    BranchInfo, BulkRepoResult, CommitPage, FileDiff, FileDiffDetail, GlobalSearchResult,
    LogCursor, RepoStatus, RepositoryId, WorkspaceId,
};
use std::path::PathBuf;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub async fn get_branches(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<Vec<BranchInfo>, AppError> {
    Ok(state.repos.get_branches(repo_id).await?)
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
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    remote: Option<String>,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .fetch(repo_id, remote.as_deref().unwrap_or("origin"))
        .await?)
}

#[tauri::command]
pub async fn pull_repo(state: State<'_, AppState>, repo_id: RepositoryId) -> Result<(), AppError> {
    Ok(state.repos.pull(repo_id).await?)
}

#[tauri::command]
pub async fn push_repo(state: State<'_, AppState>, repo_id: RepositoryId) -> Result<(), AppError> {
    Ok(state.repos.push(repo_id).await?)
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
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
) -> Result<Vec<BulkRepoResult>, AppError> {
    Ok(state.repos.bulk_fetch(workspace_id).await?)
}

#[tauri::command]
pub async fn bulk_pull(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
) -> Result<Vec<BulkRepoResult>, AppError> {
    Ok(state.repos.bulk_pull(workspace_id).await?)
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
