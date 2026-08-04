use fjord_domain::Settings;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// See docs/specs/ipc-commands.md — command names, request/response shapes,
/// and the `verb_noun` naming convention are the actual frontend/backend
/// contract, not just this file's local style.
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, AppError> {
    Ok(state.settings.get_settings().await?)
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, AppError> {
    Ok(state.settings.update_settings(settings).await?)
}
