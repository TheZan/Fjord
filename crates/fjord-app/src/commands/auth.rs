use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn answer_git_auth_prompt(
    state: State<'_, AppState>,
    operation_id: String,
    prompt_id: String,
    value: String,
) -> Result<bool, String> {
    Ok(state.askpass.answer(&operation_id, &prompt_id, value))
}

#[tauri::command]
pub async fn cancel_git_auth_prompt(
    state: State<'_, AppState>,
    operation_id: String,
    prompt_id: String,
) -> Result<bool, String> {
    Ok(state.askpass.cancel_prompt(&operation_id, &prompt_id))
}
