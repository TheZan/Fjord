use fjord_domain::{BranchInfo, CommitPage, LogCursor, RepositoryId};
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
