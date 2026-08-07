use std::path::PathBuf;

use fjord_domain::{GitEnvironmentInfo, Settings};
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

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

#[tauri::command]
pub async fn get_git_environment(
    state: State<'_, AppState>,
) -> Result<GitEnvironmentInfo, AppError> {
    Ok(state.repos.get_git_environment().await?)
}

#[tauri::command]
pub async fn select_git_executable(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<GitEnvironmentInfo, AppError> {
    Ok(state.repos.set_git_executable_path(path).await?)
}

#[tauri::command]
pub async fn reset_git_executable(
    state: State<'_, AppState>,
) -> Result<GitEnvironmentInfo, AppError> {
    Ok(state.repos.reset_git_executable_path().await?)
}
