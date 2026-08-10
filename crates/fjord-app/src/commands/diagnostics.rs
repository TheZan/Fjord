use fjord_domain::InteractionTrace;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// Drains completed backend spans. This command is intentionally not wrapped
/// in an interaction guard: recording the drain itself would leave a new trace
/// in the buffer immediately after it was emptied.
#[tauri::command]
pub fn get_interaction_traces(
    state: State<'_, AppState>,
) -> Result<Vec<InteractionTrace>, AppError> {
    if !state.interaction_traces.enabled() {
        return Err(AppError::performance_diagnostics_disabled());
    }
    Ok(state.interaction_traces.drain())
}
