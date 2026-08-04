use fjord_domain::{BranchInfo, RepositoryId};
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
