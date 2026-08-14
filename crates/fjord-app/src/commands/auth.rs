use crate::interaction_traces::TracedState;

#[tauri::command]
pub async fn answer_git_auth_prompt(
    state: TracedState<'_>,
    operation_id: String,
    prompt_id: String,
    value: String,
) -> Result<bool, String> {
    Ok(state.askpass.answer(&operation_id, &prompt_id, value))
}

#[tauri::command]
pub async fn cancel_git_auth_prompt(
    state: TracedState<'_>,
    operation_id: String,
    prompt_id: String,
) -> Result<bool, String> {
    let prompt_cancelled = state.askpass.cancel_prompt(&operation_id, &prompt_id);
    let operation_cancelled = state.operations.cancel(&operation_id);
    state.askpass.cancel_operation(&operation_id);
    Ok(prompt_cancelled || operation_cancelled)
}
