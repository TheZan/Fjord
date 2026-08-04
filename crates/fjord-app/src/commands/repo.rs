use fjord_domain::{BranchInfo, CommitPage, FileDiff, FileDiffDetail, LogCursor, RepositoryId};
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
pub async fn get_commit_log(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    cursor: Option<LogCursor>,
    limit: u32,
) -> Result<CommitPage, AppError> {
    Ok(state.repos.get_commit_log(repo_id, cursor, limit).await?)
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
